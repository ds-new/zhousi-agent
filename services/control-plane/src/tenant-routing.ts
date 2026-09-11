export interface TenantServiceRoute { dataPlaneUrl:string; dataPlaneToken:string; controlPlaneToken:string; }
export function readTenantServices(raw?:string):Record<string,TenantServiceRoute> {
  const values=raw?JSON.parse(raw):{};
  if(!values||typeof values!=='object'||Array.isArray(values))throw new Error('invalid_tenant_services');
  const secrets=new Set<string>();
  for(const [tenantId,value] of Object.entries(values)){
    const route=value as TenantServiceRoute;
    const url=new URL(route.dataPlaneUrl);
    if(!route.controlPlaneToken?.startsWith("diy_sa_"))throw new Error("invalid_control_plane_service_token");
    if(!tenantId||!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new Error('invalid_tenant_service_url');
    for(const token of [route.dataPlaneToken,route.controlPlaneToken]){
      if(typeof token!=='string'||token.length<32||secrets.has(token))throw new Error('tenant_service_tokens_must_be_distinct');
      secrets.add(token);
    }
  }
  return values;
}
