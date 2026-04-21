gcloud run deploy cssbattle-previewer-backend `
  --source . `
  --function renderPreview `
  --base-image google-22-full/nodejs22 `
  --memory 2Gi `
  --region europe-west3 `
  --allow-unauthenticated `
  --allow-unauthenticated