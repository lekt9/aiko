/** Synthetic public fixture for deployed native-login and request-DAG verification. No real accounts. */
const form='<form method="post" action="/login"><label>Email<input name="username" autocomplete="username"></label><label>Password<input type="password" name="password" autocomplete="current-password"></label><button>Sign in</button></form>';
const html=(body:string,headers:Record<string,string>={})=>new Response(`<!doctype html><title>Unlock login verification</title>${body}`,{headers:{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store",...headers}});
export default {async fetch(request:Request) {
 const url=new URL(request.url);
 const signedIn=(request.headers.get("cookie")??"").includes("unlock_canary=verified-fixture");
 if(url.pathname==="/login" && request.method==="POST") {
  const fields=await request.formData();
  if(fields.get("username")!=="fixture-user" || fields.get("password")!=="fixture-password")return html(form);
  return new Response(null,{status:303,headers:{Location:"/","Set-Cookie":"unlock_canary=verified-fixture; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=180"}});
 }
 if(url.pathname==="/logout")return html(form,{"Set-Cookie":"unlock_canary=; Path=/; Secure; HttpOnly; Max-Age=0"});
 if(url.pathname === "/test-challenge") return html('<title>Just a moment</title><script src="/cdn-cgi/challenge-platform/fixture.js"></script>');
 if(url.pathname === "/test-login") return html(form);
 if(url.pathname.startsWith("/api/")) {
  if(!signedIn)return new Response(null,{status:401});
  if(url.pathname==="/api/items")return Response.json({item:crypto.randomUUID()},{headers:{"Cache-Control":"no-store"}});
  if(url.pathname==="/api/details" && url.searchParams.has("item"))return Response.json({item:url.searchParams.get("item"),name:"Verified live canary project"},{headers:{"Cache-Control":"no-store"}});
  return new Response(null,{status:404});
 }
 if(!signedIn)return html(form);
 if(!["/","/projects"].includes(url.pathname))return new Response(null,{status:404});
 return html('<nav><a href="/">Home</a><a href="/projects">Projects</a><a href="/projects?id=12">Project 12</a><a href="/logout">Sign out</a></nav><h1>Welcome, fixture-user</h1><main id="project">Loading project</main><script>(async()=>{const item=await (await fetch("/api/items")).json();const detail=await (await fetch("/api/details?item="+encodeURIComponent(item.item))).json();document.getElementById("project").textContent=detail.name;})();</script>');
}};
