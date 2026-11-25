# Live Event Ticker Implementation

## Overview

The Live Event Ticker is a real-time streaming component that displays match events as they occur during live matches. It connects to a WebSocket to receive event updates, queues them, and displays them with smooth animations.

## Features

✅ **Real-time WebSocket Connection**: Automatically connects and reconnects to `/api/v1/live/{gameweekId}/ws`
✅ **Animated Event Cards**: Events slide in from the top with 60fps smooth animations
✅ **Smart Filtering**: "All", "My Squad", or "Fantasy Relevant" event filters
✅ **Deduplication**: Prevents duplicate events via event ID tracking
✅ **Queue Management**: Bounded queue with automatic removal of old events
✅ **Connection Status**: Visual indicator for live/reconnecting/offline states
✅ **Captain Highlighting**: Shows C (Captain) and V (Vice Captain) badges
✅ **Point Tracking**: Displays points awarded/deducted for each event
✅ **Auto-Dismiss**: Events automatically fade out after 8 seconds
✅ **Mobile Responsive**: Works on desktop and mobile with proper positioning

## Architecture

### Components

1. **LiveEventTicker** (`LiveEventTicker.tsx`)
   - Main container component
   - Manages WebSocket connection via hook
   - Renders filter controls and event stack
   - Handles positioning and layout

2. **EventTickerCard** (`EventTickerCard.tsx`)
   - Individual event display card
   - Animates in/out smoothly
   - Shows event details, icon, points
   - Auto-dismisses after timeout

### Hooks

**useEventTicker** (`hooks/useEventTicker.ts`)
- Manages WebSocket lifecycle
- Handles authentication
- Implements reconnection logic
- Delivers events individually
- Provides connection state callbacks

### Stores

**useEventTickerStore** (`store/eventTickerStore.ts`)
- Zustand store for event queue
- Manages filtering (ALL, MY_SQUAD, FANTASY_RELEVANT)
- Tracks connection state
- Handles deduplication via Set<string>

## Usage

### Basic Integration

```tsx
import { LiveEventTicker } from "@/components/live/LiveEventTicker";

export function MatchPage({ gameweekId }: { gameweekId: number }) {
  return (
    <div>
      {/* Your match content */}
      
      {/* Add the ticker */}
      <LiveEventTicker 
        gameweekId={gameweekId}
        position="top"
        showConnectionStatus={true}
        autoRemoveEventAfterMs={8000}
        maxVisibleEvents={5}
      />
    </div>
  );
}
```

### Props

```typescript
interface LiveEventTickerProps {
  gameweekId: number;              // Required: Gameweek ID to connect to
  className?: string;              // Additional CSS classes
  position?: "top" | "bottom";     // Where to position the ticker (default: "top")
  showConnectionStatus?: boolean;   // Show connection indicator (default: true)
  autoRemoveEventAfterMs?: number; // Duration before auto-removal (default: 8000ms)
  maxVisibleEvents?: number;       // Max events to show (default: 5)
}
```

### Advanced Store Usage

```tsx
import { useEventTickerStore } from "@/store/eventTickerStore";

function MyComponent() {
  const { 
    eventQueue,           // All events received
    filterMode,           // Current filter: "ALL" | "MY_SQUAD" | "FANTASY_RELEVANT"
    setFilterMode,        // Change filter
    connectionState,      // "connecting" | "open" | "reconnecting" | "closed"
    getFilteredEvents(),  // Get filtered event list
    mySquadPlayerIds,     // Set of player IDs
  } = useEventTickerStore();

  return (
    <div>
      <p>Queue size: {eventQueue.length}</p>
      <p>Status: {connectionState}</p>
      <p>Filtered events: {getFilteredEvents().length}</p>
    </div>
  );
}
```

## Event Types

The ticker supports these fantasy-relevant event types:

- **GOAL** (⚽): Player scored
- **ASSIST** (🎯): Player provided assist
- **YELLOW_CARD** (🟨): Caution issued
- **RED_CARD** (🔴): Player sent off
- **SAVE** (🛡️): Goalkeeper save
- **BONUS** (⭐): Bonus points awarded
- **PENALTY_SAVED**: Goalkeeper saved penalty
- **OWN_GOAL** (OG): Own goal

## Filtering Modes

### ALL
Shows all events from the match.

### MY_SQUAD
Shows only events for players in the user's active squad. Player IDs are synced from `useTeamStore`.

### FANTASY_RELEVANT
Shows events that directly affect fantasy points:
- GOAL, ASSIST, YELLOW_CARD, RED_CARD, BONUS, SAVE

## WebSocket Protocol

### Connection Flow

1. **Connect** to `ws://api.example.com/api/v1/live/{gameweekId}/ws`
2. **Send Auth Frame**: `{ type: "auth", token: "jwt-token" }`
3. **Receive Ready**: `{ type: "ready", gameweekId: 1, resyncRequired: true }`
4. **Receive Deltas**: `{ type: "delta", topic: "...", events: [...] }`

### Event Structure

```typescript
interface TimelineEvent {
  id: string;              // Unique event ID
  fixtureId: number;       // Match fixture ID
  fixtureName: string;     // "Arsenal vs Liverpool"
  gameweekId: number;      // Gameweek number
  playerId: number;        // Player ID
  fplId: number;          // FPL ID
  playerName: string;      // "Bukayo Saka"
  teamShortName: string;   // "ARS"
  teamId: number;         // Team ID
  type: MatchEventType;    // Event type
  minute: number;          // Match minute
  detail: string;          // Description
  pointsAwarded: number;   // Fantasy points
  timestamp: string;       // ISO timestamp
}
```

## Performance Optimizations

### Animation Performance (60fps target)
- Events slide in with GPU-accelerated CSS transforms
- Only visible events render (5 max by default)
- Unused events removed from DOM after fade-out animation
- No layout shifts due to absolute positioning

### Memory Management
- Event queue bounded to maxQueueSize (default 50)
- Deduplication set keeps at most 1000 event IDs
- Old dedup entries pruned as new ones arrive
- Zustand batches updates efficiently

### Network Efficiency
- Single WebSocket connection per gameweek
- Delta frames coalesce multiple events (max 12 per frame)
- Automatic reconnection with exponential backoff
- Auth token cached in localStorage

## Testing

Run tests:
```bash
npm test src/tests/eventTicker.test.tsx
```

Test coverage includes:
- Event card rendering and animations
- Store deduplication logic
- Filter modes (ALL, MY_SQUAD, FANTASY_RELEVANT)
- Queue size bounds
- Connection state tracking
- Event auto-removal timing
- Event type rendering

## Accessibility

- Events use `role="status"` with `aria-live="polite"`
- Each event has descriptive `aria-label`
- Dismiss button includes label
- Color indicators have text fallbacks
- Keyboard navigable filter buttons

## Browser Support

- Chrome/Edge 90+
- Firefox 88+
- Safari 14+
- Requires WebSocket support
- CSS transforms for animations

## Troubleshooting

### Events not appearing
1. Check WebSocket connection in DevTools Network tab
2. Verify auth token is valid in localStorage
3. Check console for connection errors
4. Ensure gameweekId matches active gameweek

### Animations stuttering
1. Reduce maxVisibleEvents (fewer DOM nodes)
2. Check CPU usage in DevTools Performance tab
3. Disable browser extensions that modify DOM
4. Lower animation durations if needed

### Connection keeps dropping
1. Check network reliability
2. Verify backend WebSocket server is running
3. Check firewall/proxy settings
4. Look for "Fanout is limited to 128 active API instances" in logs (scale issue)

## Future Enhancements

- [ ] Audio cues for goals/assists
- [ ] Event history export
- [ ] Custom event type filtering
- [ ] Grouped event cards (e.g., "2 goals in 5 minutes")
- [ ] Streaming to dashboard notification system
- [ ] Event search/replay
- [ ] Multi-gameweek ticker
- [ ] Team-specific ticker filtering

## File Structure

```
frontend/src/
├── hooks/
│   └── useEventTicker.ts          # WebSocket connection hook
├── store/
│   └── eventTickerStore.ts        # Zustand store
├── components/live/
│   ├── LiveEventTicker.tsx        # Main container
│   ├── EventTickerCard.tsx        # Individual event card
│   └── LiveEventTickerExample.tsx # Usage example
└── tests/
    └── eventTicker.test.tsx       # Comprehensive tests
```

## Related Files

- Backend WebSocket: `backend/src/realtime/liveSocketServer.ts`
- Event Fanout: `backend/src/services/live/eventFanout.ts`
- Type Definitions: `frontend/src/types/index.ts` (GameweekTimeline, TimelineEvent)
