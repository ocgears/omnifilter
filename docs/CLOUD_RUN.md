# Hosting the demo on Google Cloud Run

The hosted demo runs in cloud mode (`OMNIFILTER_MODE=cloud`): visitors' photos are filtered on their own GPU, in the browser, and the server only signs people in and keeps up to 5 photos each, as copies at most 2048 pixels on a side (about 1 MB each, so the free database holds a few hundred; Save on the result gives the full size). That makes the server small enough for Cloud Run's free allowance. Cloud Run runs a Docker image, starts it when a request comes in, and stops it when there's nothing to do (so it costs nothing while idle). It can't keep a database on its own disk, so MongoDB lives on MongoDB Atlas's free cluster.

```
visitor's browser ──HTTPS──▶ Cloud Run (the API, serving the built client)
                                  │
                                  └──▶ MongoDB Atlas (free cluster): accounts, kept photos
```

Part 1 is accounts and settings, done once by hand. After that, GitHub Actions deploys every change that passes the tests on master (Part 2). [How a deploy works](#how-a-deploy-works) describes the pieces.

## What it costs

Cloud Run's free allowance, each month, per billing account ([pricing](https://cloud.google.com/run/pricing)): 180,000 vCPU-seconds, 360,000 GiB-seconds and 2 million requests, with request-based billing in tier 1 regions such as `us-central1` (Iowa). With 1 vCPU and 512 MiB, that's 50 hours of the server busy answering requests every month; idle time doesn't count.

The other pieces:

| Piece | Free allowance | After that |
|---|---|---|
| Cloud Build (builds the image) | 2,500 build-minutes a month | $0.006 a minute |
| Artifact Registry (stores the image) | 0.5 GB | about $0.10 per GB a month; a cleanup policy keeps only the last few images |
| Secret Manager (the database password and the login key) | a few secrets fit in it | cents |
| MongoDB Atlas free cluster | 512 MB, 10 GB of traffic each way per week | upgrade if needed (not expected) |

Google needs a billing account (a card) even for free use. Two settings keep a mistake cheap: Cloud Run is limited to one instance, so traffic can't fan out into many paid servers, and a budget sends email alerts at $1. (A budget alerts; it doesn't stop anything.)

## Part 1: accounts and settings (by hand, once)

### 1. A Google Cloud project with billing

1. Go to https://console.cloud.google.com and sign in with the Google account that should own the demo.
2. Accept the terms. New accounts are offered a free trial with credit; accepting it is fine, and it sets up the billing account.
3. At the top, open the project picker, choose **New project**, and name it, e.g. `omnifilter-demo`. Google suggests a **project ID** under the name (such as `omnifilter-demo-482913`); it can't be changed later. Note it: the commands below start by putting it in a shell variable, `PROJECT_ID`.
4. **Billing** (from the ☰ menu): check the project is linked to the billing account.
5. **Billing → Budgets & alerts → Create budget**: scope it to this project, amount $1, alerts at 50%, 90% and 100%. Emails go to the billing account's admins.

### 2. The command line: Cloud Shell, or gcloud on the Mac

The commands below can run in **Cloud Shell**, a terminal in the browser with everything installed: click the `>_` icon at the top right of the console. Nothing to install, and it's already signed in.

Or install the CLI on the Mac: `brew install --cask gcloud-cli`, then `gcloud init` (it opens a browser to sign in, then asks for the project).

Then, either way:

```
# Your project ID, from step 1. Set this again in any new terminal or Cloud
# Shell session; every command below uses it.
PROJECT_ID=omnifilter-demo-482913
gcloud config set project $PROJECT_ID
gcloud config set run/region us-central1
gcloud services enable run.googleapis.com artifactregistry.googleapis.com \
  cloudbuild.googleapis.com secretmanager.googleapis.com iamcredentials.googleapis.com
```

Enabling the services takes a minute or two.

### 3. A free MongoDB Atlas cluster

1. Sign up at https://www.mongodb.com/cloud/atlas/register (a Google sign-in works).
2. **Create a cluster**: choose **Free**, provider **Google Cloud**, and region **Iowa (us-central1)**, the same region as Cloud Run (Atlas shows which regions have free clusters; take the nearest one if Iowa doesn't). Name it, e.g. `omnifilter`.
3. **Database access → Add new database user**: user name `omnifilter`, **Autogenerate secure password**, copy the password somewhere safe for a minute, role **Read and write to any database**.
4. **Network access → Add IP address → Allow access from anywhere** (`0.0.0.0/0`). Cloud Run doesn't have a fixed outgoing address, so Atlas can't be limited to it without a paid network setup; the long generated password is what protects the database.
5. **Connect → Drivers**: copy the connection string. It looks like `mongodb+srv://omnifilter:<db_password>@omnifilter.abcde.mongodb.net/?retryWrites=true&w=majority`. Put the password in place of `<db_password>`, and add the database name `omnifilter` after the `/`: `...mongodb.net/omnifilter?retryWrites=true&w=majority`.

### 4. The two secrets

The connection string, and the key that signs login tokens (`APP_SECRET`), go in Secret Manager rather than in the repository or the workflow:

```
printf '%s' 'mongodb+srv://omnifilter:PASSWORD@.../omnifilter?retryWrites=true&w=majority' |
  gcloud secrets create mongodb-uri --data-file=-
openssl rand -hex 32 | tr -d '\n' | gcloud secrets create app-secret --data-file=-
```

(Starting a Cloud Shell command with a space keeps it out of the shell's history.)

### 5. Where images go, and who may deploy

```
# A Docker repository for the app's images, keeping only the newest 3.
gcloud artifacts repositories create omnifilter --repository-format=docker --location=us-central1
cat > cleanup-policy.json <<'JSON'
[{"name": "keep-newest-3", "action": {"type": "Keep"}, "mostRecentVersions": {"keepCount": 3}},
 {"name": "delete-the-rest", "action": {"type": "Delete"}, "condition": {"tagState": "any"}}]
JSON
gcloud artifacts repositories set-cleanup-policies omnifilter --location=us-central1 \
  --policy=cleanup-policy.json --no-dry-run

# The account the app runs as: it can read the two secrets, nothing else.
gcloud iam service-accounts create omnifilter-run --display-name="OmniFilter (runs the app)"
for s in mongodb-uri app-secret; do
  gcloud secrets add-iam-policy-binding $s --role=roles/secretmanager.secretAccessor \
    --member=serviceAccount:omnifilter-run@$PROJECT_ID.iam.gserviceaccount.com
done
```

GitHub Actions deploys without a stored key: Workload Identity Federation lets a workflow run from `ocgears/omnifilter`'s master branch act as a deploy account, and nothing else can.

```
PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')

gcloud iam workload-identity-pools create github --location=global --display-name=GitHub
gcloud iam workload-identity-pools providers create-oidc omnifilter --location=global \
  --workload-identity-pool=github --issuer-uri=https://token.actions.githubusercontent.com \
  --attribute-mapping=google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref \
  --attribute-condition="assertion.repository == 'ocgears/omnifilter' && assertion.ref == 'refs/heads/master'"

gcloud iam service-accounts create omnifilter-deploy --display-name="OmniFilter (deploys from GitHub)"
DEPLOY=omnifilter-deploy@$PROJECT_ID.iam.gserviceaccount.com
gcloud projects add-iam-policy-binding $PROJECT_ID --member=serviceAccount:$DEPLOY --role=roles/run.admin \
  --condition=None
gcloud artifacts repositories add-iam-policy-binding omnifilter --location=us-central1 \
  --member=serviceAccount:$DEPLOY --role=roles/artifactregistry.writer
gcloud iam service-accounts add-iam-policy-binding omnifilter-run@$PROJECT_ID.iam.gserviceaccount.com \
  --member=serviceAccount:$DEPLOY --role=roles/iam.serviceAccountUser
gcloud iam service-accounts add-iam-policy-binding $DEPLOY --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/github/attribute.repository/ocgears/omnifilter"

# The values for step 6:
echo "GCP_PROJECT:      $PROJECT_ID"
echo "GCP_REGION:       us-central1"
echo "GCP_WIF_PROVIDER: projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/github/providers/omnifilter"
echo "GCP_DEPLOY_SA:    $DEPLOY"
```

### 6. Tell GitHub where to deploy

In https://github.com/ocgears/omnifilter → **Settings → Secrets and variables → Actions → Variables → New repository variable**, add these four (they name things; none of them is a secret):

| Variable | Value |
|---|---|
| `GCP_PROJECT` | your project ID |
| `GCP_REGION` | `us-central1` |
| `GCP_WIF_PROVIDER` | printed by the last commands above |
| `GCP_DEPLOY_SA` | printed by the last commands above |

Then **Settings → Environments → New environment** named `production`: under **Deployment branches and tags**, allow only `master`, and tick **Required reviewers** with yourself. A deploy waits for that approval once, after its checks have passed, before visitors see it.

Optionally, the smoke test can sign in: in **Settings → Environments**, the `smoke` environment (made by the first deploy, or make it now; no reviewers), add two **environment secrets**, `SMOKE_EMAIL` and `SMOKE_PASSWORD`: an email address and a long password for an account kept for this (the test makes it the first time). Without them it skips signing in.

## Part 2: the first deploy

**Actions → deploy → Run workflow** on master. It builds the image, deploys it, runs the smoke test and Lighthouse against it, and sends visitors to it. The run's summary gives the address, `https://omnifilter-<something>.us-central1.run.app`. (The very first deploy serves visitors as soon as it starts, since a new service can't start with none; there's nothing older to keep serving anyway.)

After that, every change merged to master deploys the same way once the test workflow has passed on it. If a check fails, the revision that was serving keeps serving, and the run says what failed.

**Going back to an earlier version:** the console's **Cloud Run → omnifilter → Revisions** lists every deploy; **Manage traffic** sends 100% to any of them. Or: `gcloud run services update-traffic omnifilter --to-revisions=REVISION=100`.

**Logs:** **Cloud Run → omnifilter → Logs**, or `gcloud run services logs read omnifilter --limit=100`.

## Part 3: a domain of your own (optional)

The `run.app` address works as it is. For a domain such as `omnifilter.example.com`: **Cloud Run → Manage custom domains → Add mapping**, verify the domain with Google (it walks through adding a DNS record), then add the DNS records it shows. The certificate is issued automatically, which can take up to a day. Domain mapping is in preview and offered in some regions, `us-central1` among them.

## How a deploy works

**The image**, `docker/cloud-run.Dockerfile` (about 100 MB compressed):
- the client is built with `OMNIFILTER_API=/`, so the page calls the API at its own address. (The root `Dockerfile`'s client calls port 3000 of the page's host, which is right for `docker compose` but not on Cloud Run, where everything is on one HTTPS address.)
- no OpenCL, no native addon and no neural style models: in cloud mode the server doesn't filter, and doesn't try to set up a device (`/device` answers `null`).
- `OMNIFILTER_MODE=cloud`, `NODE_ENV=production`, and port 8080, which Cloud Run expects.
- quick to start, since the first visitor after an idle spell waits for it: no ONNX Runtime (the neural style filters' 180 MB, which cloud mode doesn't run), Node's compile cache filled when the image is built (as the user the server runs as: Node keeps one per user), sharp loads only when a photo is read or written, and Cloud Run's startup CPU boost is on. `/health` gives a server that has just started a few seconds to connect to the database, and a server that can't reach the database keeps trying (every 5 s, doubling up to a minute) rather than giving up.
- CI's `cloud-run` job builds it on every push, runs it beside a MongoDB, and runs the smoke test against it.

**`.github/workflows/deploy.yml`**, after the test workflow passes on master, or on demand from master, in three jobs:
1. **candidate**: stops if another commit has reached master since this one (that commit's deploy follows, so an older commit can't go live over a newer one); signs in to Google Cloud through Workload Identity Federation (`google-github-actions/auth`); builds the image and pushes it to Artifact Registry, tagged with the commit; deploys it as a revision tagged `candidate`, with no visitors: one instance at most, none when idle, 1 CPU and 512 MiB, billed only while answering requests, with the two secrets and `TRUST_PROXY=1`.
2. **check**: runs the smoke test and Lighthouse against the candidate's own address (`https://candidate---omnifilter-....run.app`). This job can't sign in to Google Cloud, so the test tools it downloads never hold the deploy account's credentials.
3. **promote**, if the checks passed, in the `production` environment, so it waits for its reviewer's approval: if the commit is still master's newest, sends all visitors to it.

If the checks fail, **withdraw** removes the `candidate` address without waiting for anyone, so a failed revision isn't left reachable, and the revision serving before carries on.

**The smoke test**, `e2e/smoke/deployed.smoke.js` (`SMOKE_URL=<address> npx playwright test -c e2e/smoke` runs it from anywhere):
- `GET /health` (the first request to a new revision, so its time, noted on the run, is a cold start's): the database is connected, and the server sees the test at the runner's own public address, not at an address made up in an `X-Forwarded-For` header (that checks `TRUST_PROXY`, which the per-address limits on sign-ins rely on);
- `GET /settings` says cloud mode with 5 photos each, and `/device` is `null`;
- the page has the API address meta tag, and its scripts come compressed and cacheable for a year;
- as a guest, the sample photo is filtered at full size in the browser (CI's Chromium has WebGPU through SwiftShader) and the result card says 12.0 MP, with no errors on the page;
- with `SMOKE_EMAIL` and `SMOKE_PASSWORD`, signing in works. Nothing is kept, so the database doesn't fill up.

**Lighthouse** on the candidate (`LHCI_URL=<address> .github/lighthouse/node_modules/.bin/lhci autorun`, after `npm ci --prefix .github/lighthouse`), with the same budgets as CI's lighthouse job. The smoke test has woken the instance by then, so a cold start doesn't count against it. Against the image on a Mac: performance 80, accessibility, best practices and SEO 100.

**Nightly**, `.github/workflows/smoke.yml` runs the smoke test against the live address, so a broken database connection or an expired setting shows up without waiting for a deploy.
