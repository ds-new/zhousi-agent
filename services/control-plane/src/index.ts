import {startControlPlaneFromEnv} from './server.js';
const cp=await startControlPlaneFromEnv();
console.log(`control-plane listening on ${cp.baseUrl}`);
let closing=false;
const shutdown=async()=>{
 if(closing)return;closing=true;
 const deadline=setTimeout(()=>process.exit(1),150000);deadline.unref();
 try{await cp.close();clearTimeout(deadline);process.exit(0);}catch{process.exit(1);}
};
process.once('SIGINT',()=>void shutdown());process.once('SIGTERM',()=>void shutdown());
