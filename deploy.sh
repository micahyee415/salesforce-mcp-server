#!/bin/bash
set -euo pipefail

# Deploy salesforce-mcp to Cloud Run via Cloud Build
# Usage: npm run deploy  (or: bash deploy.sh)

PROJECT="your-gcp-project"
echo "Deploying salesforce-mcp to Cloud Run (project: $PROJECT)..."
gcloud builds submit --config cloudbuild.yaml --project "$PROJECT" .
echo "Done. Check: gcloud run services describe salesforce-mcp --region us-central1 --project $PROJECT"
