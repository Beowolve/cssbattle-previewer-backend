gcloud run deploy cssbattle-previewer-backend `
  --source . `
  --function renderPreview `
  --base-image google-22-full/nodejs22 `
  --region europe-west3 `
  --allow-unauthenticated `
  --allow-unauthenticated