// Minimal OpenID Connect provider for the SSO tests.
// It logs in the user set with setUser() without asking anything. Optional user fields:
//   groups:   sent as the `groups` claim
//   groupsIn: where the groups are sent, "id_token" (default), "userinfo" or "none"
// Refreshes use the current state of the user, so group changes apply on the next refresh.
import http from "node:http";
import crypto from "node:crypto";

const b64url = (b) => Buffer.from(b).toString("base64url");

function json(res, status, data) {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
}

async function readBody(req) {
    let data = "";
    for await (const chunk of req) data += chunk;
    return data;
}

export function startMockOidc(port) {
    const issuer = `http://localhost:${port}`;
    const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = { ...publicKey.export({ format: "jwk" }), kid: "test", use: "sig", alg: "RS256" };
    let user = { sub: "user-1", email: "sso@example.com" };
    const users = new Map([[user.sub, user]]);
    const current = (sub) => users.get(sub);
    const groupClaims = (u, where) => (u.groups && (u.groupsIn || "id_token") === where ? { groups: u.groups } : {});
    const codes = new Map();
    const tokens = new Map();
    const refreshTokens = new Map();

    const sign = (claims) => {
        const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "test" }));
        const body = b64url(JSON.stringify(claims));
        const sig = crypto.sign("RSA-SHA256", Buffer.from(`${header}.${body}`), privateKey);
        return `${header}.${body}.${b64url(sig)}`;
    };

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, issuer);
        if (url.pathname === "/.well-known/openid-configuration") {
            return json(res, 200, {
                issuer,
                authorization_endpoint: `${issuer}/authorize`,
                token_endpoint: `${issuer}/token`,
                userinfo_endpoint: `${issuer}/userinfo`,
                jwks_uri: `${issuer}/jwks`,
                response_types_supported: ["code"],
                subject_types_supported: ["public"],
                id_token_signing_alg_values_supported: ["RS256"],
                scopes_supported: ["openid", "email", "profile"],
                token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
                code_challenge_methods_supported: ["S256"],
            });
        }
        if (url.pathname === "/jwks") return json(res, 200, { keys: [jwk] });
        if (url.pathname === "/authorize") {
            const p = url.searchParams;
            const code = crypto.randomBytes(16).toString("hex");
            codes.set(code, { nonce: p.get("nonce"), clientId: p.get("client_id"), challenge: p.get("code_challenge"), sub: user.sub });
            const redirect = new URL(p.get("redirect_uri"));
            redirect.searchParams.set("code", code);
            redirect.searchParams.set("state", p.get("state"));
            res.writeHead(302, { Location: redirect.href });
            return res.end();
        }
        if (url.pathname === "/token" && req.method === "POST") {
            const form = new URLSearchParams(await readBody(req));
            const now = Math.floor(Date.now() / 1000);
            const idToken = (u, clientId, nonce) =>
                sign({
                    iss: issuer,
                    sub: u.sub,
                    aud: clientId || "vaultwarden",
                    iat: now,
                    exp: now + 300,
                    ...(nonce ? { nonce } : {}),
                    email: u.email,
                    email_verified: true,
                    ...groupClaims(u, "id_token"),
                });
            if (form.get("grant_type") === "refresh_token") {
                const r = refreshTokens.get(form.get("refresh_token"));
                if (!r) return json(res, 400, { error: "invalid_grant" });
                const access = crypto.randomBytes(16).toString("hex");
                tokens.set(access, r.sub);
                return json(res, 200, {
                    access_token: access,
                    token_type: "Bearer",
                    expires_in: 300,
                    id_token: idToken(current(r.sub), r.clientId),
                    refresh_token: form.get("refresh_token"),
                });
            }
            const entry = codes.get(form.get("code"));
            if (!entry) return json(res, 400, { error: "invalid_grant" });
            codes.delete(form.get("code"));
            if (entry.challenge) {
                const expected = b64url(crypto.createHash("sha256").update(form.get("code_verifier") || "").digest());
                if (expected !== entry.challenge) return json(res, 400, { error: "invalid_grant", error_description: "PKCE" });
            }
            const access = crypto.randomBytes(16).toString("hex");
            tokens.set(access, entry.sub);
            const refresh = crypto.randomBytes(16).toString("hex");
            refreshTokens.set(refresh, { sub: entry.sub, clientId: entry.clientId });
            return json(res, 200, {
                access_token: access,
                token_type: "Bearer",
                expires_in: 300,
                id_token: idToken(current(entry.sub), entry.clientId, entry.nonce),
                refresh_token: refresh,
            });
        }
        if (url.pathname === "/userinfo") {
            const sub = tokens.get((req.headers.authorization || "").replace(/^Bearer /, ""));
            if (!sub) return json(res, 401, { error: "invalid_token" });
            const u = current(sub);
            return json(res, 200, { sub: u.sub, email: u.email, email_verified: true, ...groupClaims(u, "userinfo") });
        }
        json(res, 404, { error: "not found" });
    });

    return new Promise((resolve) => {
        server.listen(port, "127.0.0.1", () =>
            resolve({
                issuer,
                setUser: (u) => {
                    user = { ...u };
                    users.set(user.sub, user);
                },
                stop: () => new Promise((r) => server.close(r)),
            }),
        );
    });
}
