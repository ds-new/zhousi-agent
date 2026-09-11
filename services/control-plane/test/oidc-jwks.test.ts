import assert from "node:assert/strict";
import { it } from "node:test";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { createJwksOidcVerifier } from "@diy-agent/auth";
import { MemoryStore } from "@diy-agent/db";
import { resolveAuthContext, type AuthOptions } from "../src/auth-middleware.js";

it("remote JWKS verifies asymmetric tokens and reuses its cache across middleware requests", async () => {
  const pair = await generateKeyPair("ES256");
  const jwk = { ...await exportJWK(pair.publicKey), kid: "primary", alg: "ES256", use: "sig" };
  let requests = 0;
  const options: AuthOptions = { mode: "api_key", jwksOidc: {
    issuer: "https://identity.example", audience: "diy-agent", jwksUrl: "https://identity.example/jwks",
    fetchImpl: async (url) => {
      assert.equal(String(url), "https://identity.example/jwks");
      requests += 1;
      return Response.json({ keys: [jwk] });
    },
  } };
  const token = await new SignJWT({ tenant_id: "tenant-a" }).setProtectedHeader({ alg: "ES256", kid: "primary", jku: "https://attacker.invalid/jwks" })
    .setIssuer("https://identity.example").setAudience("diy-agent").setSubject("alice").setIssuedAt().setExpirationTime("5m").sign(pair.privateKey);
  const req = new IncomingMessage(new Socket()); req.headers.authorization = `Bearer ${token}`;
  const store = new MemoryStore();
  assert.equal((await resolveAuthContext(req, store, options))?.tenantId, "tenant-a");
  assert.equal((await resolveAuthContext(req, store, options))?.subject, "alice");
  assert.equal(requests, 1);
});

it("remote JWKS rejects wrong issuer, audience, missing expiry, malformed tenant and invalid signatures", async () => {
  const pair = await generateKeyPair("ES256");
  const wrong = await generateKeyPair("ES256");
  const jwk = { ...await exportJWK(pair.publicKey), kid: "primary", alg: "ES256" };
  const verifier = createJwksOidcVerifier({ issuer: "https://identity.example", audience: "diy-agent", jwksUrl: "https://identity.example/jwks",
    fetchImpl: async () => Response.json({ keys: [jwk] }) });
  const now = Math.floor(Date.now() / 1000);
  for (const overrides of [{ iss: "wrong" }, { aud: "wrong" }, { exp: undefined }, { exp: now - 1 }, { nbf: now + 60 }, { iat: now + 60 }, { tenant_id: ["tenant-a"] }]) {
    const token = await new SignJWT({ iss: "https://identity.example", aud: "diy-agent", sub: "alice", tenant_id: "tenant-a", iat: now, exp: now + 60, ...overrides })
      .setProtectedHeader({ alg: "ES256", kid: "primary" }).sign(pair.privateKey);
    assert.equal(await verifier(token), null);
  }
  const forged = await new SignJWT({ iss: "https://identity.example", aud: "diy-agent", sub: "alice", tenant_id: "tenant-a", iat: now, exp: now + 60 })
    .setProtectedHeader({ alg: "ES256", kid: "primary" }).sign(wrong.privateKey);
  assert.equal(await verifier(forged), null);
  assert.throws(() => createJwksOidcVerifier({ issuer: "test", audience: "diy", jwksUrl: "http://identity.example/jwks" }), /https_required/);
});

it("remote JWKS refreshes for rotated keys after its bounded cooldown", async (t) => {
  const now = Date.now();
  t.mock.timers.enable({ apis: ["Date"], now });
  const first = await generateKeyPair("ES256"); const second = await generateKeyPair("ES256");
  const firstJwk = { ...await exportJWK(first.publicKey), kid: "first", alg: "ES256" };
  const secondJwk = { ...await exportJWK(second.publicKey), kid: "second", alg: "ES256" };
  let calls = 0;
  const verifier = createJwksOidcVerifier({ issuer: "https://identity.example", audience: "diy-agent", jwksUrl: "https://identity.example/jwks",
    fetchImpl: async () => Response.json({ keys: ++calls === 1 ? [firstJwk] : [firstJwk, secondJwk] }) });
  const issue = (key: CryptoKey, kid: string) => new SignJWT({ tenant_id: "tenant-a" }).setProtectedHeader({ alg: "ES256", kid })
    .setIssuer("https://identity.example").setAudience("diy-agent").setSubject("alice").setIssuedAt().setExpirationTime("5m").sign(key);
  assert.ok(await verifier(await issue(first.privateKey, "first")));
  t.mock.timers.setTime(now + 31_000);
  assert.ok(await verifier(await issue(second.privateKey, "second")));
  assert.equal(calls, 2);
});
