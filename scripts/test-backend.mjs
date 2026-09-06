import { spawnSync } from 'node:child_process'
if(!process.env.UNLOCK_TEST_DATABASE_URL){console.error('Set UNLOCK_TEST_DATABASE_URL to a dedicated local PostgreSQL test database. Each run creates and drops its own unlock_test_* schema.');process.exit(1)}
const url=new URL(process.env.UNLOCK_TEST_DATABASE_URL)
if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname)){console.error('Backend tests require an explicit loopback test database.');process.exit(1)}
const build=spawnSync('pnpm',['build:backend'],{stdio:'inherit',env:process.env});if(build.status!==0)process.exit(build.status??1)
const result=spawnSync('pnpm',['exec','vitest','run','tests/backend','--maxWorkers=2'],{stdio:'inherit',env:process.env});process.exit(result.status??1)
