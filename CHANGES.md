# LiveKit Meet - Changes Summary

## Overview
This document summarizes all modifications made to enable local network multi-device video conferencing with HTTPS support.

---

## 1. Docker Build Configuration

### File: `next.config.js`
**Change:** Added `output: 'standalone'` configuration
```javascript
const nextConfig = {
  output: 'standalone',  // NEW: Enable Next.js standalone mode for Docker
  reactStrictMode: false,
  // ... rest of config
}
```
**Why:** Required for Docker deployment with minimal image size (~150MB vs ~1GB)

### File: `Dockerfile`
**Change:** Fixed public folder copy in runner stage
```dockerfile
# Before (incorrect)
RUN mkdir -p public

# After (correct)
COPY --from=builder /app/public ./public
```
**Why:** Background images and assets weren't being deployed

---

## 2. Git LFS Background Images

### File: `lib/CameraSettings.tsx`
**Change:** Temporarily disabled static image imports
```typescript
// Before (caused build failures)
import Desk from '../public/background-images/samantha-gades-BlIhVfXbi9s-unsplash.jpg';
import Nature from '../public/background-images/ali-kazal-tbw_KQE3Cbg-unsplash.jpg';

// After (builds successfully)
// Note: Background images are stored in Git LFS. Install git-lfs and run 'git lfs pull' to download them
// import Desk from '../public/background-images/samantha-gades-BlIhVfXbi9s-unsplash.jpg';
// import Nature from '../public/background-images/ali-kazal-tbw_KQE3Cbg-unsplash.jpg';

const BACKGROUND_IMAGES: Array<{ name: string; path: { src: string } }> = [
  // { name: 'Desk', path: Desk },
  // { name: 'Nature', path: Nature },
];
```
**Why:** Background images were Git LFS pointers (130 bytes), not actual images. Build failed without git-lfs.

**To restore:**
```bash
sudo apt-get install git-lfs
cd /home/tdhadmin/Git/voice-ai-agent/meet
git lfs install
git lfs pull
# Uncomment imports in lib/CameraSettings.tsx
docker compose build meet
```

---

## 3. Network Configuration

### File: `docker-compose.yml` - Meet Service
**Changes:**
```yaml
meet:
  build:
    context: ./meet
    network: host
    args:
      # Changed from localhost to host IP
      NEXT_PUBLIC_LIVEKIT_URL: ws://192.168.128.8:7880
  environment:
    # NEW: Server-side LIVEKIT_URL for token generation
    - LIVEKIT_URL=ws://192.168.128.8:7880
    - LIVEKIT_API_KEY=devkey
    - LIVEKIT_API_SECRET=secret
    # Changed from localhost to host IP
    - NEXT_PUBLIC_LIVEKIT_URL=ws://192.168.128.8:7880
  depends_on:
    - livekit
  network_mode: host
```

### File: `docker-compose.yml` - LiveKit Service
**Changes:**
```yaml
livekit:
  image: livekit/livekit-server:latest
  # NEW: Added --node-ip flag for WebRTC ICE candidates
  command: --dev --bind "0.0.0.0" --node-ip "192.168.128.8"
  network_mode: host
```

**Why these changes:**
- `LIVEKIT_URL` (server-side): Required by `/api/connection-details` to generate tokens with correct serverUrl
- `--node-ip`: LiveKit must advertise correct IP for WebRTC connections from remote devices
- Without `--node-ip`, remote devices connect via WebSocket but WebRTC media fails (audio/video missing)

---

## 4. HTTPS Support (Self-Signed Certificate)

### New File: `meet/generate-cert.sh`
```bash
#!/bin/bash
# Generate self-signed certificate for local development
mkdir -p certs
cd certs
openssl req -x509 -newkey rsa:4096 -keyout key.pem -out cert.pem -days 365 -nodes \
  -subj "/C=US/ST=State/L=City/O=Organization/CN=192.168.128.8" \
  -addext "subjectAltName=IP:192.168.128.8,DNS:localhost"
```

### New File: `meet/Dockerfile.nginx`
```dockerfile
FROM nginx:alpine
COPY nginx.conf /etc/nginx/nginx.conf
EXPOSE 443
CMD ["nginx", "-g", "daemon off;"]
```

### New File: `meet/nginx.conf`
```nginx
events {
    worker_connections 1024;
}

http {
    upstream nextjs {
        server 127.0.0.1:3000;
    }

    server {
        listen 8443 ssl;
        http2 on;
        server_name 192.168.128.8;

        ssl_certificate /etc/nginx/certs/cert.pem;
        ssl_certificate_key /etc/nginx/certs/key.pem;

        location / {
            proxy_pass http://nextjs;
            proxy_http_version 1.1;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection 'upgrade';
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
            proxy_cache_bypass $http_upgrade;
        }
    }
}
```

### File: `docker-compose.yml` - New Nginx Service
```yaml
meet-nginx:
  build:
    context: ./meet
    dockerfile: Dockerfile.nginx
  volumes:
    - ./meet/certs:/etc/nginx/certs:ro
  depends_on:
    - meet
  network_mode: host
```

**Why HTTPS is required:**
- Browsers block `navigator.mediaDevices` on non-localhost HTTP
- Remote devices got "getUserMedia is undefined" errors
- `crypto.randomUUID()` also requires secure context (chat was broken)
- Self-signed cert is free and works for local networks

---

## 5. "Join Existing" Feature

### New File: `app/api/rooms/active/route.ts`
```typescript
import { RoomServiceClient } from 'livekit-server-sdk';
import { NextResponse } from 'next/server';

export async function GET() {
  const roomService = new RoomServiceClient(LIVEKIT_URL, API_KEY, API_SECRET);
  const rooms = await roomService.listRooms();
  
  const activeRooms = rooms
    .filter((room) => room.numParticipants > 0)
    .map((room) => ({
      name: room.name,
      numParticipants: room.numParticipants,
      creationTime: room.creationTime,
    }));
  
  return NextResponse.json({ rooms: activeRooms });
}
```

### File: `app/page.tsx` - Major Changes
**Added:**
1. `ActiveRoom` interface for TypeScript types
2. `JoinExistingTab` component with:
   - Auto-refresh every 5 seconds
   - Manual refresh button
   - Room cards showing participant count and creation time
   - One-click join functionality
3. Updated `Tabs` component to handle 3 tabs (was 2)
4. Tab routing: `?tab=join` query parameter

**Key implementation:**
```typescript
function JoinExistingTab(props: { label: string }) {
  const [activeRooms, setActiveRooms] = useState<ActiveRoom[]>([]);
  
  const fetchActiveRooms = async () => {
    const response = await fetch('/api/rooms/active');
    const data = await response.json();
    setActiveRooms(data.rooms || []);
  };

  useEffect(() => {
    fetchActiveRooms();
    const interval = setInterval(fetchActiveRooms, 5000);
    return () => clearInterval(interval);
  }, []);

  const joinRoom = (roomName: string) => {
    router.push(`/rooms/${roomName}`);
  };
  // ... UI rendering
}
```

**User workflow:**
1. Device A: Start Meeting → Creates room `abc-123`
2. Device B: Open home page → Click "Join Existing" tab
3. Device B: See room `abc-123` with participant count
4. Device B: Click "Join" button → Enter room without knowing ID

---

## Summary of Access Points

| Service | URL | Purpose |
|---------|-----|---------|
| Meet (HTTPS) | `https://192.168.128.8:8443` | Main access (recommended) |
| Meet (HTTP) | `http://192.168.128.8:3000` | Fallback (limited features) |
| LiveKit | `ws://192.168.128.8:7880` | WebSocket signaling |
| Active Rooms API | `/api/rooms/active` | List active rooms |

---

## Browser Security

### HTTPS Certificate Warning
Users will see on first access:
- **Chrome/Edge**: "Your connection is not private" → Advanced → Proceed
- **Firefox**: "Warning: Potential Security Risk Ahead" → Advanced → Accept Risk
- **Safari**: "This Connection Is Not Private" → Show Details → Visit Website

Browser remembers the exception, so warning only appears once per device.

### HTTP Limitations (without HTTPS)
Remote devices on HTTP cannot:
- ❌ Access camera/microphone (`navigator.mediaDevices` undefined)
- ❌ Send chat messages (`crypto.randomUUID()` unavailable)
- ✅ Can view others' video/audio (receive-only mode)
- ✅ Can connect to room via WebSocket

**Workaround:** Enable in browser flags (not recommended for production):
- Chrome: `chrome://flags/#unsafely-treat-insecure-origin-as-secure`
- Add: `http://192.168.128.8:3000`

---

## Testing Checklist

### Single Device (localhost)
- [ ] Access `https://192.168.128.8:8443`
- [ ] Accept certificate warning
- [ ] Start meeting → camera/mic work
- [ ] Enable background blur
- [ ] Send chat message

### Multi-Device (network)
- [ ] Device A: Start meeting, copy URL
- [ ] Device B: Open same URL → Join → See Device A
- [ ] Device B: Click "Join Existing" tab → See Device A's room
- [ ] Device B: Join via button → Both see each other
- [ ] Both: Camera/mic/chat functional
- [ ] Test with 3+ devices simultaneously

---

## Troubleshooting

### Build fails with image errors
**Issue:** Git LFS images not downloaded  
**Fix:** See section 2 above, or use the workaround (images disabled)

### Remote device can't publish camera/mic
**Issue:** HTTP context, not HTTPS  
**Fix:** Use `https://192.168.128.8:8443`, accept certificate warning

### WebRTC connection fails (no audio/video)
**Issue:** LiveKit not advertising correct IP  
**Fix:** Verify `--node-ip "192.168.128.8"` in docker-compose.yml

### "Join Existing" shows no rooms
**Issue:** API can't connect to LiveKit or no active participants  
**Fix:** Check `LIVEKIT_URL` environment variable is set server-side

### nginx "invalid response"
**Issue:** Browser cache or certificate issue  
**Fix:** Clear browser state, try incognito mode, or use port 8443 instead of 443

---

## Files Modified/Created

**Modified:**
- `meet/next.config.js` - Added standalone output
- `meet/Dockerfile` - Fixed public folder copy
- `meet/lib/CameraSettings.tsx` - Disabled LFS images
- `docker-compose.yml` - Network config, nginx service
- `meet/app/page.tsx` - Added "Join Existing" tab

**Created:**
- `meet/app/api/rooms/active/route.ts` - Active rooms API
- `meet/generate-cert.sh` - SSL certificate generator
- `meet/Dockerfile.nginx` - Nginx container
- `meet/nginx.conf` - Nginx HTTPS configuration
- `meet/certs/cert.pem` - Self-signed certificate (generated)
- `meet/certs/key.pem` - Private key (generated)
- `meet/.github/copilot-instructions.md` - Updated AI agent guidelines
- `meet/CHANGES.md` - This file

---

## Quick Start Commands

```bash
# One-time setup
cd /home/tdhadmin/Git/voice-ai-agent/meet
chmod +x generate-cert.sh
./generate-cert.sh

# Start services
cd /home/tdhadmin/Git/voice-ai-agent
docker compose up --build livekit meet meet-nginx

# Access from any device
Open: https://192.168.128.8:8443
Accept certificate warning
Start or join meetings!
```

---

## Future Improvements

1. **Real certificate**: Use Let's Encrypt with domain name for no browser warnings
2. **Authentication**: Add login system for recording endpoints
3. **Persistent storage**: Save room history, recordings metadata
4. **QR codes**: Generate QR for easy mobile device joining
5. **Room passwords**: Optional password protection for rooms
6. **Invite by email**: Email invitations from "Join Existing" tab
7. **Room expiry**: Auto-cleanup empty rooms after timeout
