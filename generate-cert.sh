#!/bin/bash
# Generate self-signed certificate for local development

mkdir -p certs
cd certs

# Generate private key and certificate
openssl req -x509 -newkey rsa:4096 -keyout key.pem -out cert.pem -days 365 -nodes \
  -subj "/C=US/ST=State/L=City/O=Organization/CN=192.168.128.8" \
  -addext "subjectAltName=IP:192.168.128.8,DNS:localhost"

echo "Certificate generated in certs/ directory"
echo "Clients will need to accept the security warning in their browser"
