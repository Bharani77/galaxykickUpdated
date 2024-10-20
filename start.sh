#!/bin/bash

# No need to explicitiy authenticate with gcloud, as it will use GOOGLE_APPLICATION_CREDENTIALS
cd /galaxybackend

ngrok config add-authtoken 2fiR7UShJZw4BRbqbUmFI1gSFUD_3MuFRUmLQeGUsoNAziN89

ngrok http --domain=profound-frank-mackerel.ngrok-free.app 5000 | tee ngrok.log &

# Wait for ngrok to generate its output
sleep 5

NGROK_URL=$(curl -s http://localhost:4040/api/tunnels | jq -r '.tunnels[] | .public_url')
# Extract the public URL from ngrok's output

if [ -z "$NGROK_URL" ]; then
    echo "Failed to get ngrok URL"
    exit 1
fi

echo "Deployment completed successfully!"