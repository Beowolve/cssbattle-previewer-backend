gcloud run deploy cssbattle-previewer-backend `
  --source . `
  --function renderPreview `
  --base-image google-22-full/nodejs22 `
  --automatic-updates `
  --memory 2Gi `
  --timeout 15s `
  --region europe-west3 `
  --allow-unauthenticated
