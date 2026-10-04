# Pocketful — stage 2

Node.js 22 HTTP service plus a browser UI, standard library only (no npm dependencies, no
external fonts, scripts or CDNs, no runtime network).

Build and run (from the repository root):

```sh
docker build -t pocketful-s2 stage-2
docker run --rm -e PORT=8080 -p 8080:8080 pocketful-s2
```

The service listens on `0.0.0.0:$PORT` (default `8080`); `GET /health` returns `{"status":"ok"}`.
State is in memory; seed it with `POST /_test/reset`.

Open the app in a browser at <http://localhost:8080/> (it redirects to `/login` until you sign in).
Screens: `/` wallet, pay, request and activity · `/requests` · `/split` · `/authorizations` (holds) ·
`/login` · `/signup`. `/requests` and `/authorizations` serve the UI for `Accept: text/html` and
the JSON API otherwise. The UI's script and styles are served from `/assets/`.

Without Docker: `PORT=8080 node stage-2/server.js` (Node.js 22).
