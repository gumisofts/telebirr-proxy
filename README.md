# telebirr-proxy

A small forwarding proxy for the Telebirr receipt server. It passes an allowed request to one
fixed upstream and streams the answer back. No dependencies: one file, `app.js`.

It is locked down on purpose:

- The upstream host is fixed in the configuration. A caller cannot make it fetch anything else.
- Every request needs the key. A wrong or missing key gets a plain 404.
- Only the listed paths and methods are forwarded (by default `GET`/`HEAD` under `/receipt/`).
- Cookies, `Authorization`, the key and the caller's IP headers are never sent upstream.
- Logs hold the time, caller IP, method, status and duration. Never the body, the query string,
  the key or the receipt number.

## Configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `PROXY_KEY` | required | The shared secret, at least 24 characters |
| `UPSTREAM_URL` | `https://transactioninfo.ethiotelecom.et` | Where requests are forwarded |
| `ALLOWED_PATHS` | `/receipt/` | Path prefixes that are forwarded (comma separated) |
| `ALLOWED_METHODS` | `GET,HEAD` | Methods that are forwarded |
| `ALLOWED_IPS` | empty | Only these caller IPs (comma separated). Empty = any caller with the key |
| `UPSTREAM_TIMEOUT_MS` | `20000` | Give up on the upstream after this long |
| `UPSTREAM_VERIFY_TLS` | `true` | `false` only if the upstream certificate cannot be verified |
| `TRUST_FORWARDED_FOR` | `true` | Read the caller IP from `X-Forwarded-For` (right for Plesk, where nginx is in front) |
| `MAX_BODY_BYTES` | `1048576` | Largest request body |
| `MAX_CONCURRENT` | `50` | Requests in flight at once; more get 503 |
| `LOG_REQUESTS` | `true` | One line per request |

Make a key:

```
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

## Deploy on Plesk

1. Create a domain or subdomain for the proxy (for example `tb.example.com`) and issue its
   certificate (SSL/TLS Certificates, Let's Encrypt).
2. Upload `app.js` and `package.json` to the domain's application folder (File Manager or Git).
3. Open **Node.js** on the domain:
   - Node.js version: 18 or newer
   - Application root: the folder with `app.js`
   - Application startup file: `app.js`
   - Application mode: `production`
4. Under **Custom environment variables**, add `PROXY_KEY` (and any others from the table).
5. Press **Enable Node.js**, then **Restart App** after every change.

There is nothing to `npm install`.

Check it:

```
curl https://tb.example.com/healthz
curl -H "X-Proxy-Key: <key>" https://tb.example.com/receipt/SOMEID
```

## Calling it

Two ways to present the key:

- Header: `X-Proxy-Key: <key>` with the normal path, `/receipt/<id>`.
- In the path, for a client that can only be given a base URL: `/k/<key>/receipt/<id>`.

For a backend that builds the receipt URL as `<base>/<transaction id>`, set its base URL to:

```
https://tb.example.com/k/<key>/receipt
```

With the key in the path, the web server's own access log on the Plesk host will contain it.
Either use `ALLOWED_IPS` as well, or turn off access logging for this domain.

## Answers the proxy itself gives

| Status | Meaning |
|---|---|
| 404 | Wrong or missing key, or the caller's IP is not allowed |
| 403 | The path is not in `ALLOWED_PATHS` |
| 405 | The method is not in `ALLOWED_METHODS` |
| 413 | The body is larger than `MAX_BODY_BYTES` |
| 502 | The upstream could not be reached |
| 503 | Too many requests in flight |
| 504 | The upstream did not answer in time |

Anything else is the upstream's own answer, passed through.

## Other endpoints

To proxy a different server or API, change `UPSTREAM_URL`, `ALLOWED_PATHS` and
`ALLOWED_METHODS` (for example `ALLOWED_METHODS=GET,POST`, `ALLOWED_PATHS=/api/`). One instance
serves one upstream; run a second instance for a second server.

## Run and test locally

```
PROXY_KEY=<key> node app.js          # listens on PORT, default 3000
npm test
```
