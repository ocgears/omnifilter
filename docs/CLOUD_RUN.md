# Hosting the demo on Google Cloud Run

The hosted demo runs in cloud mode (`OMNIFILTER_MODE=cloud`): visitors' photos are filtered on their own GPU, in the browser, and the server only signs people in and keeps up to 5 photos each. That makes the server small enough for Cloud Run's free allowance. Cloud Run runs a Docker image, starts it when a request comes in, and stops it when there's nothing to do (so it costs nothing while idle). It can't keep a database on its own disk, so MongoDB lives on MongoDB Atlas's free cluster.

```
visitor's browser ──HTTPS──▶ Cloud Run (the API, serving the built client)
                                  │
                                  └──▶ MongoDB Atlas (free cluster): accounts, kept photos
```

Part 1 is accounts and settings, done once by hand, and can be done now. Parts 2 and 3 use files that the deploy work (the plan at the end) adds to the repository.

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
3. At the top, open the project picker, choose **New project**, and name it, e.g. `omnifilter-demo`. Google suggests a **project ID** under the name (such as `omnifilter-demo-482913`); it can't be changed later. Note it; the commands below call it `PROJECT_ID`.
4. **Billing** (from the ☰ menu): check the project is linked to the billing account.
5. **Billing → Budgets & alerts → Create budget**: scope it to this project, amount $1, alerts at 50%, 90% and 100%. Emails go to the billing account's admins.

### 2. The command line: Cloud Shell, or gcloud on the Mac

The commands below can run in **Cloud Shell**, a terminal in the browser with everything installed: click the `>_` icon at the top right of the console. Nothing to install, and it's already signed in.

Or install the CLI on the Mac: `brew install --cask gcloud-cli`, then `gcloud init` (it opens a browser to sign in, then asks for the project).

Then, either way:

```
gcloud config set project PROJECT_ID
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
    --member=serviceAccount:omnifilter-run@PROJECT_ID.iam.gserviceaccount.com
done
```

GitHub Actions deploys without a stored key: Workload Identity Federation lets a workflow run from `ocgears/omnifilter`'s master branch act as a deploy account, and nothing else can.

```
PROJECT_NUMBER=$(gcloud projects describe PROJECT_ID --format='value(projectNumber)')

gcloud iam workload-identity-pools create github --location=global --display-name=GitHub
gcloud iam workload-identity-pools providers create-oidc omnifilter --location=global \
  --workload-identity-pool=github --issuer-uri=https://token.actions.githubusercontent.com \
  --attribute-mapping=google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref \
  --attribute-condition="assertion.repository == 'ocgears/omnifilter' && assertion.ref == 'refs/heads/master'"

gcloud iam service-accounts create omnifilter-deploy --display-name="OmniFilter (deploys from GitHub)"
DEPLOY=omnifilter-deploy@PROJECT_ID.iam.gserviceaccount.com
gcloud projects add-iam-policy-binding PROJECT_ID --member=serviceAccount:$DEPLOY --role=roles/run.admin
gcloud artifacts repositories add-iam-policy-binding omnifilter --location=us-central1 \
  --member=serviceAccount:$DEPLOY --role=roles/artifactregistry.writer
gcloud iam service-accounts add-iam-policy-binding omnifilter-run@PROJECT_ID.iam.gserviceaccount.com \
  --member=serviceAccount:$DEPLOY --role=roles/iam.serviceAccountUser
gcloud iam service-accounts add-iam-policy-binding $DEPLOY --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/github/attribute.repository/ocgears/omnifilter"

echo "GCP_WIF_PROVIDER: projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/github/providers/omnifilter"
```

### 6. Tell GitHub where to deploy

In https://github.com/ocgears/omnifilter → **Settings → Environments → New environment** named `production`. Under **Deployment branches and tags**, allow only `master`. Then add these **environment variables** (they name things; none of them is a secret):

| Variable | Value |
|---|---|
| `GCP_PROJECT` | `PROJECT_ID` |
| `GCP_REGION` | `us-central1` |
| `GCP_WIF_PROVIDER` | what the last command above printed |
| `GCP_DEPLOY_SA` | `omnifilter-deploy@PROJECT_ID.iam.gserviceaccount.com` |

## Part 2: the first deploy

Once the deploy workflow is merged: **Actions → deploy → Run workflow** on master. It builds the image, deploys it as a new revision with no traffic, runs the smoke test against that revision, and only then sends visitors to it. The run's summary gives the address, `https://omnifilter-<something>.us-central1.run.app`.

After that, every merge to master deploys the same way. If a smoke test fails, the revision that was serving keeps serving, and the run says what failed.

**Going back to an earlier version:** the console's **Cloud Run → omnifilter → Revisions** lists every deploy; **Manage traffic** sends 100% to any of them. Or: `gcloud run services update-traffic omnifilter --to-revisions=REVISION=100`.

**Logs:** **Cloud Run → omnifilter → Logs**, or `gcloud run services logs read omnifilter --limit=100`.

## Part 3: a domain of your own (optional)

The `run.app` address works as it is. For a domain such as `omnifilter.example.com`: **Cloud Run → Manage custom domains → Add mapping**, verify the domain with Google (it walks through adding a DNS record), then add the DNS records it shows. The certificate is issued automatically, which can take up to a day. Domain mapping is in preview and offered in some regions, `us-central1` among them.

## The plan: what the deploy work adds

### Step 4: building and deploying

1. **An image for Cloud Run**, `docker/cloud-run.Dockerfile`, from the same stages as the root `Dockerfile`, with:
   - the client built with `OMNIFILTER_API=/`, so the page calls the API at its own address. (The root image's client calls port 3000 of the page's host, which is right for `docker compose` but not on Cloud Run, where everything is on one HTTPS address.)
   - no neural style models, and no pocl: in cloud mode the server doesn't filter. The server already starts without OpenCL (`server/lib/native.js` reports it as unavailable instead of failing). Smaller images start faster from zero.
   - `OMNIFILTER_MODE=cloud` and `NODE_ENV=production` set in the image; `PORT` comes from Cloud Run.
   - checked locally under Colima, and by CI's existing `docker` job.
2. **Server settings for Cloud Run**: `TRUST_PROXY` set so the per-IP limits see visitors' addresses rather than Google's front end (the smoke test checks which address the server sees), and a quick health route if `/device` turns out to be slow without OpenCL.
3. **`.github/workflows/deploy.yml`**, on pushes to master and on demand, in the `production` environment:
   - signs in to Google Cloud through Workload Identity Federation (`google-github-actions/auth`),
   - builds the image and pushes it to Artifact Registry, tagged with the commit,
   - `gcloud run deploy omnifilter --image=... --no-traffic --tag=candidate` with: `--service-account=omnifilter-run`, `--set-secrets=MONGOLAB_URI=mongodb-uri:latest,APP_SECRET=app-secret:latest`, `--max-instances=1`, `--min-instances=0`, `--cpu=1 --memory=512Mi`, `--concurrency=40`, `--allow-unauthenticated` (it's a public website), and request-based billing,
   - runs step 5 against the candidate's own address,
   - then `gcloud run services update-traffic omnifilter --to-tags=candidate=100`.
4. Optionally, **`docs/cloud-run/setup.sh`**, Part 1 steps 4 to 6 as one script for Cloud Shell, so a second environment (a staging copy, say) is one command.

### Step 5: checking each deploy

Before a revision gets traffic, the workflow tests it where it runs:

1. **`e2e/smoke.spec.js`**, a short Playwright test run against the candidate's address (`SMOKE_URL`; it uses no local servers):
   - the page loads with no console errors, over HTTPS, with its replies compressed;
   - `GET /settings` says `cloud`, with 5 stored photos;
   - as a guest: the sample photo is filtered on the device (CI's Chromium has WebGPU through SwiftShader) and the result card shows 12.0 MP;
   - signing in with a dedicated smoke-test account (its password a GitHub secret) works, and the account's photo count is within the limit. It keeps nothing, so the database doesn't fill up.
   - The server's view of the visitor's address is right (the `TRUST_PROXY` check above).
2. **Lighthouse on the live address** (`lhci autorun --collect.url=<candidate>`), with the same assertions as CI's lighthouse job. The real network and HTTPS show things a local run can't, such as compression through Google's front end and cold-start time. A cold start that pushes the score below the bar would be a warning, not a failure, since the first visitor after an idle spell always pays it.
3. **If anything fails**, traffic stays on the old revision, the run ends red with the failure as an annotation, and the candidate is left (with no traffic) to look at.
4. **Nightly**, the same smoke test against the live address, so a broken database connection or an expired setting is noticed without a deploy.

What you'd do: Part 1 (about 30 minutes, mostly waiting for pages), then merge the deploy branch and run the workflow.
