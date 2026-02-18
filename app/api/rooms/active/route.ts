import { RoomServiceClient } from 'livekit-server-sdk';
import { NextResponse } from 'next/server';

const API_KEY = process.env.LIVEKIT_API_KEY;
const API_SECRET = process.env.LIVEKIT_API_SECRET;
const LIVEKIT_URL = process.env.LIVEKIT_URL;

export async function GET() {
  try {
    if (!LIVEKIT_URL || !API_KEY || !API_SECRET) {
      throw new Error('LiveKit configuration is missing');
    }

    // Convert WebSocket URL to HTTP URL for the RoomServiceClient
    const httpUrl = LIVEKIT_URL.replace('ws://', 'http://').replace('wss://', 'https://');
    
    console.log('Connecting to LiveKit at:', httpUrl);
    const roomService = new RoomServiceClient(httpUrl, API_KEY, API_SECRET);
    const rooms = await roomService.listRooms();
    console.log(`Found ${rooms.length} total rooms`);

    // Filter to only rooms with participants
    const activeRooms = rooms
      .filter((room) => room.numParticipants > 0)
      .map((room) => ({
        name: room.name,
        numParticipants: room.numParticipants,
        creationTime: Number(room.creationTime),
      }));

    console.log(`Filtered to ${activeRooms.length} active rooms with participants`);
    console.log('Active rooms:', activeRooms);

    return NextResponse.json({ rooms: activeRooms });
  } catch (error) {
    console.error('Error fetching active rooms:', error);
    return NextResponse.json({ rooms: [], error: 'Failed to fetch rooms' }, { status: 500 });
  }
}
