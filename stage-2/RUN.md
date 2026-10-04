# Pocketful — stage 2

Node.js 22 HTTP service, standard library only (no npm dependencies, no runtime network).

Build and run (from the repository root):

```sh
docker build -t pocketful-s2 stage-2
docker run --rm -e PORT=8080 -p 8080:8080 pocketful-s2
```

The service listens on `0.0.0.0:$PORT` (default `8080`); `GET /health` returns `{"status":"ok"}`.
State is in memory; seed it with `POST /_test/reset`.

Without Docker: `PORT=8080 node stage-2/server.js` (Node.js 22).
