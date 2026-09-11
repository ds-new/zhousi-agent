import type { IncomingMessage } from 'node:http';
export async function readJsonBody(req:IncomingMessage):Promise<Record<string,unknown>>{
 const chunks:Buffer[]=[];let size=0;
 for await(const chunk of req){size+=Buffer.byteLength(chunk);if(size>2*1024*1024)throw new Error('request_too_large');chunks.push(Buffer.from(chunk));}
 const body=chunks.length?JSON.parse(Buffer.concat(chunks).toString('utf8')):{};
 if(!body||typeof body!=='object'||Array.isArray(body))throw new SyntaxError('invalid_json');return body;
}
export async function readLimitedJson<T>(response:Response,maxBytes=1024*1024):Promise<T>{
 const reader=response.body?.getReader();if(!reader)throw new Error('empty_response');const chunks:Uint8Array[]=[];let size=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>maxBytes)throw new Error('response_size_limit');chunks.push(value);}
 return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
export function errorStatus(error:unknown):number{
 const name=error instanceof Error?error.message:'';
 if(error instanceof SyntaxError)return 400;
 if(name==='request_too_large'||name==='response_size_limit')return 413;
 if(/quota|capacity/.test(name))return 429;
 if(/session_busy|idempotency|outcome_unknown|approval/.test(name))return 409;
 if(/tenant_mismatch|policy_denied|origin_not_allowed/.test(name))return 403;
 if(/^invalid_|_required$/.test(name))return 400;
 return 502;
}
