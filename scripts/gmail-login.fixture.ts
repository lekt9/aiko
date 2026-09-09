/** Isolated, synthetic Google + relying-party fixtures. Requires explicit Chrome
 * host mappings. No real credentials, OAuth clients, mail delivery or accounts. */
const key = process.env.UNLOCK_FIXTURE_TLS_KEY, cert = process.env.UNLOCK_FIXTURE_TLS_CERT;
if (!key || !cert) throw Error("Fixture TLS key and certificate required");
const GOOGLE = "accounts.google.com", MAIL = "mail.google.com";
const SSO = "sso-login-fixture.aiko.ai", OTP = "otp-login-fixture.aiko.ai", LINK = "link-login-fixture.aiko.ai";
const identity = "fixture@example.test";
const metrics = { ssoRequests: 0, accountChoices: 0, consents: 0, otpRequests: 0, linkRequests: 0, otpConsumed: 0, linkConsumed: 0 };
const messages: { from: string; to: string; signedBy: string; date: string; text: string; link?: string }[] = [];
const pending = new Map<string, { host: string; value: string; consumed: boolean; variant?: string }>();
const grants = new Map<string, { host: string; state: string }>();
const page = (body: string) => new Response(`<!doctype html><meta name="unlock-gmail-fixture" content="synthetic"><meta name="viewport" content="width=device-width"><title>Unlock Gmail fixture</title>${body}`, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
const redirect = (location: string, cookie?: string) => new Response(null, { status: 302, headers: { location, ...(cookie ? { "set-cookie": cookie } : {}) } });
const cookie = (name: string, value: string) => `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax`;
const cookies = (request: Request) => Object.fromEntries((request.headers.get("cookie") ?? "").split(";").map(entry => entry.trim().split("=")));
const html = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
const account = `<a aria-label="Google Account: Fixture (${identity})">Google account</a>`;
const server = Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.UNLOCK_FIXTURE_PORT ?? 19443), tls: { key: Bun.file(key), cert: Bun.file(cert) },
  async fetch(request) {
    const url = new URL(request.url), host = url.hostname, jar = cookies(request);
    if (url.pathname === "/fixture-metrics") return Response.json(metrics);
    if (![MAIL, GOOGLE, SSO, OTP, LINK].includes(host)) return new Response("Unknown fixture host", { status: 404 });
    if (host === MAIL) {
      if (jar.sid !== "synthetic-google-session") return redirect(`https://${GOOGLE}/signin`);
      return page(`${account}<nav role="navigation"><a href="#inbox">Inbox</a></nav><main role="main"><h1>Inbox</h1><p>Synthetic mailbox is ready.</p><div id="messages"></div></main><script>
        const messages=${JSON.stringify(messages).replace(/</g, "\\u003c")};
        const render=()=>{const query=decodeURIComponent(location.hash),root=document.querySelector('#messages');root.replaceChildren();if(!query.startsWith('#search/'))return;
          const domain=query.match(/from:\\(@([^)]*)\\)/)?.[1], recipient=query.match(/to:([^ ]+)/)?.[1], after=Number(query.match(/after:(\\d+)/)?.[1]||0)*1000;
          const table=document.createElement('table');root.append(table);
          for(const m of messages.filter(m=>m.from.endsWith('@'+domain)&&m.to===recipient&&Date.parse(m.date)>=after)) {const row=table.insertRow();row.className='zA';row.insertCell().textContent='New sign-in email';row.onclick=()=>{
            root.replaceChildren();const container=document.createElement('div');container.className='adn';root.append(container);const headers=document.createElement('table');container.append(headers);
            for(const [name,value] of [['from',m.from],['to',m.to],['date',m.date],['signed-by',m.signedBy]]){const r=headers.insertRow();r.insertCell().textContent=name+':';r.insertCell().textContent=value;}
            const body=document.createElement('div');body.className='a3s';body.textContent=m.text;container.append(body);if(m.link){const a=document.createElement('a');a.textContent='Sign in';a.href=m.link;body.append(a);}
          };}
        };addEventListener('hashchange',render);render();</script>`);
    }
    if (host === GOOGLE) {
      if (url.pathname === "/o/oauth2/v2/auth") {
        if (jar.sid !== "synthetic-google-session") return page('<h1>Sign in</h1><input type="password">');
        const destination = new URL(url.searchParams.get("redirect_uri") || "https://invalid.test");
        if (destination.hostname !== SSO) return new Response("Invalid relying party", { status: 400 });
        if (url.searchParams.get("phase") === "allow") {
          metrics.consents++;
          const code = crypto.randomUUID(); grants.set(code, { host: SSO, state: url.searchParams.get("state")! });
          destination.searchParams.set("state", url.searchParams.get("state")!); destination.searchParams.set("code", code);
          return redirect(destination.href);
        }
        if (url.searchParams.get("phase") === "consent") {
          metrics.accountChoices++; const next = new URL(url); next.searchParams.set("phase", "allow");
          return page(`<h1>${SSO} wants to share your Google profile</h1><p>Share your name, email and profile picture to sign in.</p><button onclick="location.href='${html(next.href)}'">Continue</button>`);
        }
        const next = new URL(url); next.searchParams.set("phase", "consent");
        return page(`<h1>Choose an account</h1><button data-identifier="${identity}" onclick="location.href='${html(next.href)}'">Fixture account</button>`);
      }
      if (request.method === "POST") {
        const fields = await request.formData();
        if (url.pathname === "/identifier" && fields.get("username") === identity) return redirect("/password");
        if (url.pathname === "/password" && fields.get("password") === "fixture-password") return redirect("/verify");
        if (url.pathname === "/verify" && fields.get("code") === "654321") return redirect(`https://${MAIL}/mail/u/0/`, "sid=synthetic-google-session; Domain=.google.com; Path=/; Secure; HttpOnly; SameSite=Lax");
        return page("<h1>Sign-in not accepted</h1>");
      }
      if (url.pathname === "/password") return page('<h1>Sign in</h1><form method="post" action="/password"><input name="action" type="hidden" value="login"><label>Password<input type="password" name="password" autocomplete="current-password"></label><button>Next</button></form>');
      if (url.pathname === "/verify") return page('<h1>Check your phone</h1><p>Enter your verification code.</p><form method="post" action="/verify"><label>Code<input name="code" autocomplete="one-time-code"></label><button>Verify</button></form>');
      return page('<h1>Sign in</h1><form id="login" method="post" action="/identifier"><input name="action" type="hidden" value="login"><label>Email<input name="username" autocomplete="username"></label></form><button type="submit" form="login">Next</button>');
    }
    if (jar.connected === host) return page(`<h1>Signed in to ${host}</h1><button data-testid="account-menu" data-email="${pending.get(jar.pending!)?.variant === 'wrong-account' ? 'other@example.test' : identity}">Your account</button>`);
    if (host === SSO) {
      if (url.pathname === "/start") {
        metrics.ssoRequests++; const state = crypto.randomUUID();
        const target = new URL(`https://${GOOGLE}/o/oauth2/v2/auth`);
        target.searchParams.set("redirect_uri", `https://${SSO}/callback`); target.searchParams.set("scope", "openid email profile"); target.searchParams.set("state", state);
        return redirect(target.href, cookie("oauth_state", state));
      }
      if (url.pathname === "/callback") {
        const grant = grants.get(url.searchParams.get("code")!);
        if (!grant || grant.host !== host || grant.state !== jar.oauth_state || grant.state !== url.searchParams.get("state")) return new Response("Invalid OAuth state", { status: 403 });
        grants.delete(url.searchParams.get("code")!); return redirect("/", cookie("connected", host));
      }
      return page('<h1>Sign in</h1><a href="/start">Continue with Google</a>');
    }
    if (url.pathname === "/email" && request.method === "POST") {
      const fields = await request.formData();
      if (fields.get("username") !== identity) return new Response("Wrong recipient", { status: 400 });
      const id = crypto.randomUUID(), value = host === OTP ? String(100000 + crypto.getRandomValues(new Uint32Array(1))[0]! % 900000) : crypto.randomUUID();
      const variant = url.searchParams.get("fixture_case") || undefined;
      pending.set(id, { host, value, consumed: false, variant });
      if (host === OTP) metrics.otpRequests++; else metrics.linkRequests++;
      const reference = variant === "wrong-request" ? crypto.randomUUID() : id;
      const email = { from: `signin@${host}`, to: identity, signedBy: variant === "wrong-signer" ? "untrusted.example" : host, date: new Date().toISOString(),
        text: host === OTP ? `Your verification code is ${value}. Use it to sign in. Request: ${reference}` : `Use this link to sign in to your account. Request: ${reference}`,
        ...(host === LINK ? { link: `https://${variant === "foreign-link" ? "untrusted.example" : host}/accept?token=${value}&state=${reference}` } : {}),
      };
      messages.push(email);
      if (variant === "ambiguous") messages.push({ ...email });
      return redirect("/waiting", cookie("pending", id));
    }
    if (url.pathname === "/accept" || url.pathname === "/verify") {
      const current = pending.get(jar.pending!);
      const value = request.method === "POST" ? (await request.formData()).getAll("code").join("") : url.searchParams.get("token");
      if (!current || current.host !== host || current.consumed || current.value !== value || host === LINK && url.searchParams.get("state") !== jar.pending) return new Response("Invalid or consumed sign-in", { status: 403 });
      current.consumed = true; if (host === OTP) metrics.otpConsumed++; else metrics.linkConsumed++;
      return redirect("/", cookie("connected", host));
    }
    if (url.pathname === "/waiting") return page(host === OTP ? `<h1>Check your email</h1><form method="post" action="/verify"><input type="hidden" name="state" value="${html(jar.pending || '')}"><fieldset><legend>Verification code</legend>${Array.from({ length: 6 }, (_, index) => `<input name="code" aria-label="Digit ${index + 1}" maxlength="1" inputmode="numeric" ${index === 0 ? 'autocomplete="one-time-code"' : ''}>`).join('')}</fieldset><button>Verify</button></form>` : `<h1>Check your inbox</h1><p>A sign-in link was sent to your email.</p><input type="hidden" name="state" value="${html(jar.pending || '')}">`);
    return page(`<h1>Sign in</h1><form method="post" action="/email?fixture_case=${encodeURIComponent(url.searchParams.get('fixture_case') || '')}"><label>Email<input name="username" autocomplete="username" type="email"></label><button>Continue</button></form>`);
  },
});
console.log(`Synthetic Gmail chain fixture on 127.0.0.1:${server.port}`);
