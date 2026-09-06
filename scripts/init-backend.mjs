import { generateKeyPairSync,randomBytes } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
const path=process.argv[2]
if(!path){console.error('Usage: node scripts/init-backend.mjs /private/path/server.json. Creates keys but no owner, demo bypass, or production deployment.');process.exit(1)}
try{
  const {privateKey}=generateKeyPairSync('rsa',{modulusLength:3072})
  const config={origin:'https://vault.example',port:4180,localDevelopment:false,databaseUrl:'postgresql://CHANGE_ME@127.0.0.1:5432/unlock',encryption:{kind:'local',active:'initial',keys:{initial:randomBytes(32).toString('base64')}},oauth:{jwks:{keys:[{...privateKey.export({format:'jwk'}),kid:'initial',use:'sig',alg:'RS256'}]},cookieKeys:[randomBytes(48).toString('base64url')]},recipes:[]}
  await writeFile(path,JSON.stringify(config,null,2)+'\n',{flag:'wx',mode:0o600})
  console.log('Private starter configuration created. Configure origin, database, upstream owner OIDC and approved recipes before use. Keep this file out of source control.')
}catch{console.error('Configuration was not created. Check the path; existing files are never overwritten.');process.exitCode=1}
