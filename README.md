# Launch Tracker

A tracker for brand and store launches, built on [Gr8r Studio](https://github.com/gr8rstudio/gr8r-studio).
The web app in `gr8r-studio/` is served by a small Node.js server in `server/`, which also reports
whether PostgreSQL and Blob storage are reachable. CI builds one container image per commit, and that
same image runs on Windows, on a Mac and in Azure.

## Check it on your computer

You need [Docker Desktop](https://www.docker.com/products/docker-desktop/) or
[Podman Desktop](https://podman-desktop.io/), started. The check downloads the newest image that
passed CI on main and runs it with an empty database and empty storage, then runs the smoke test.

Mac (Terminal):

```sh
curl -fsSLO https://raw.githubusercontent.com/muttonkodibiriyani/Project-Management-Tool/main/local/check.sh
bash check.sh
```

Windows (PowerShell):

```powershell
curl.exe -fsSLO https://raw.githubusercontent.com/muttonkodibiriyani/Project-Management-Tool/main/local/check.ps1
powershell -ExecutionPolicy Bypass -File .\check.ps1
```

It ends with `Smoke test passed.`, the commit and the image digest, and leaves the app running at
http://127.0.0.1:8080. If anything is unreachable, it says what and how to fix it. Stop it with
`bash check.sh --stop` on a Mac, or `powershell -ExecutionPolicy Bypass -File .\check.ps1 -Stop`
on Windows. To check a particular build, pass the image from that CI run's summary:
`--image ghcr.io/muttonkodibiriyani/launch-tracker@sha256:<digest>`. `bash check.sh --help` lists
every option; the Windows script takes the same ones with a single dash (`-Image`, `-Port`, `-Engine`,
`-Stop`).

## Develop

Node.js 22 (see `gr8r-studio/.nvmrc`). Run each line from the repository's top folder.

```sh
(cd gr8r-studio && npm ci && npm run dev)            # the web app on its own
(cd gr8r-studio && npm ci && npm run build)          # build the web app, which the server's tests serve
(cd server && npm ci && npm run lint && npm test)    # the server
docker build --build-arg GIT_COMMIT=$(git rev-parse HEAD) -t launch-tracker .
```

The database tests need a throwaway PostgreSQL 16 that they may create databases and roles in; without
one they are skipped locally (CI always runs them):

```sh
docker run -d --name lt-test-postgres -p 127.0.0.1:55432:5432 -e POSTGRES_HOST_AUTH_METHOD=trust postgres:16-alpine
cd server && TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/postgres npm test
```

Schema changes are new numbered files in `server/src/db/migrations/` (never an edit of one that has
shipped). The image applies them with `dist/migrate.js` as the schema owner before the app starts;
`npm run migrate` does the same with the `PG*` settings of the shell. Running it again applies nothing.

Every pull request runs lint, type checks and tests; ShellCheck and PSScriptAnalyzer on the check
scripts; CodeQL, gitleaks over the whole history, Checkov and Trivy; then builds the image for amd64
and arm64, scans it, runs both check scripts against it with Docker and Podman, and drives it end
to end in Chromium and Firefox. On main, the image that passed all of that is tagged `main`.

### End-to-end tests

`e2e/` holds the browser tests. They run against an image by digest, the same one CI built, with
PostgreSQL, Blob storage and Playwright all in containers, so you need only Docker or Podman:

```sh
bash e2e/run.sh --image ghcr.io/muttonkodibiriyani/launch-tracker@sha256:<digest>
bash e2e/run.sh --image <name>@sha256:<digest> --browser firefox --repeat 3   # hunt for flaky tests
```

`tests/gr8r-checklist/` checks that every gr8r-studio feature we keep still works, one file per
group of features in section 2 of the product spec. Each test starts from the seeded demo workspace
in a fresh browser, with the clock fixed and synthetic data only. A failed test leaves a trace,
screenshot and video in `e2e/test-results`; in CI they are attached to the run.

## Licence

Our own code is under the Apache License 2.0 (see `LICENSE`). The files in `gr8r-studio/` belong to
their author and are not covered by it; see `NOTICE`.
