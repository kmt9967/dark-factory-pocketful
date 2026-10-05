# Pocketful — stage 3

Node.js 22 HTTP service plus a browser UI, standard library only (no npm dependencies, no
external fonts, scripts or CDNs, no runtime network).

Build and run (from the repository root):

```sh
docker build -t pocketful-s3 stage-3
docker run --rm -e PORT=8080 -p 8080:8080 pocketful-s3
```

The service listens on `0.0.0.0:$PORT` (default `8080`); `GET /health` returns `{"status":"ok"}`.
State is in memory; seed it with `POST /_test/reset`.

Open the app in a browser at <http://localhost:8080/> (it redirects to `/login` until you sign in).
Screens: `/` wallet, pay, request and activity · `/requests` · `/split` · `/authorizations` (holds) ·
`/login` · `/signup`. `/requests` and `/authorizations` serve the UI for `Accept: text/html` and
the JSON API otherwise. The UI's script and styles are served from `/assets/`.

Without Docker: `PORT=8080 node stage-3/server.js` (Node.js 22).

Ledger reads (stage 3): `GET /me?as_of=<RFC 3339>&known_at=<RFC 3339>` returns historical
balance/available/held, and `GET /statement?from=&to=&known_at=&limit=&offset=` returns a paginated
statement with a `snapshot` token (`GET /statement?snapshot=<token>&limit=&offset=` pages it).
Write the offset's `+` raw or as `%2B`; both mean `+`.
