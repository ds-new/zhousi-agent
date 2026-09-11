import { startDataPlaneFromEnv } from './server.js';
const dp=await startDataPlaneFromEnv();
let closing=false;
const shutdown=async()=>{
 if(closing)return;closing=true;
 const deadline=setTimeout(()=>process.exit(1),150000);deadline.unref();
 try{await dp.close();clearTimeout(deadline);process.exit(0);}catch{process.exit(1);}
};
process.once('SIGTERM',()=>void shutdown());process.once('SIGINT',()=>void shutdown());
