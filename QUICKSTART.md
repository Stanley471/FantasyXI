# Live Event Ticker - Quick Start Guide

## 30 Second Integration

Add real-time match events to any gameweek/match page:

```tsx
import { LiveEventTicker } from "@/components/live/LiveEventTicker";

export function GameweekPage() {
  return (
    <>
      {/* Your existing content */}
      <div>Match info, standings, etc.</div>

      {/* Add this 1 line */}
      <LiveEventTicker gameweekId={1} />
    </>
  );
}
```

That's it! Events will start streaming in real-time.

## What You Get

✅ Live event cards sliding in from the top  
✅ Goals, assists, cards, saves, bonus points  
✅ Filter for "My Squad" or "Fantasy Relevant" events  
✅ Auto-reconnection on network issues  
✅ Captain/Vice Captain badges  
✅ Points display (green gains, red deductions)  
✅ Auto-dismiss after 8 seconds  
✅ Manual dismiss button  
✅ Connection status indicator  

## Full Example

```tsx
import { LiveEventTicker } from "@/components/live/LiveEventTicker";

export function MatchdayDashboard({ gameweekId }: { gameweekId: number }) {
  return (
    <div className="p-4">
      <h1>Gameweek {gameweekId} Live</h1>

      {/* The ticker - position top or bottom */}
      <LiveEventTicker
        gameweekId={gameweekId}
        position="top"                    // or "bottom"
        showConnectionStatus={true}       // Show live/offline indicator
        autoRemoveEventAfterMs={8000}     // 8 seconds before auto-dismiss
        maxVisibleEvents={5}              // Show max 5 cards at once
      />

      {/* Your other content */}
      <div className="mt-32">
        {/* Fixtures, standings, etc */}
      </div>
    </div>
  );
}
```

## Accessing Store Data

Get real-time stats for your own UI:

```tsx
import { useEventTickerStore } from "@/store/eventTickerStore";

function EventStats() {
  const { eventQueue, connectionState } = useEventTickerStore();

  return (
    <div>
      <p>Events received: {eventQueue.length}</p>
      <p>Status: {connectionState === 'open' ? '🟢 Live' : '🔴 Offline'}</p>
    </div>
  );
}
```

## Files You Got

| File | Purpose | Size |
|------|---------|------|
| `useEventTicker.ts` | WebSocket hook | 150 lines |
| `eventTickerStore.ts` | Zustand store | 110 lines |
| `EventTickerCard.tsx` | Event card | 190 lines |
| `LiveEventTicker.tsx` | Container | 200 lines |
| `eventTicker.test.tsx` | Tests | 300 lines |

## Filtering

Three built-in filter modes users can toggle:

```
┌─────────────────────────────────────────┐
│ All Events │ My Squad │ Fantasy Points │
└─────────────────────────────────────────┘
```

- **All Events**: Every goal, assist, card, save, bonus
- **My Squad**: Only your players' events  
- **Fantasy Points**: Only events that affect fantasy points

## Events Shown

| Event | Icon | Points |
|-------|------|--------|
| Goal | ⚽ | +5 (varies) |
| Assist | 🎯 | +1 |
| Yellow Card | 🟨 | -1 |
| Red Card | 🔴 | -3 |
| Save | 🛡️ | +1 |
| Bonus | ⭐ | +1 to +3 |

## Connection Status

Top-left indicator shows:
- 🟢 **Live** - Connected and receiving events
- 🟡 **Reconnecting** - Temporarily offline, auto-retrying
- 🔴 **Offline** - Not connected (check internet)

Auto-reconnects up to 5 times with increasing delays.

## Customization

### Change Position

```tsx
// Top of screen (default)
<LiveEventTicker gameweekId={1} position="top" />

// Bottom of screen
<LiveEventTicker gameweekId={1} position="bottom" />
```

### Change Event Duration

```tsx
// Show for 5 seconds instead of 8
<LiveEventTicker gameweekId={1} autoRemoveEventAfterMs={5000} />
```

### Show More/Fewer Events

```tsx
// Show up to 10 events instead of 5
<LiveEventTicker gameweekId={1} maxVisibleEvents={10} />
```

### Hide Connection Status

```tsx
// Don't show the indicator
<LiveEventTicker gameweekId={1} showConnectionStatus={false} />
```

### Add CSS Classes

```tsx
// Add custom styling
<LiveEventTicker 
  gameweekId={1} 
  className="z-50 shadow-2xl"
/>
```

## Testing

Run tests to verify everything works:

```bash
# All ticker tests
npm test src/tests/eventTicker.test.tsx

# Specific test
npm test -- -t "EventTickerCard"
npm test -- -t "deduplicates"
```

## Common Questions

**Q: Do I need to install anything?**  
A: No! Uses existing packages (React, Zustand, Tailwind).

**Q: Will it work offline?**  
A: Events won't arrive, but it gracefully shows "Offline" status and auto-reconnects.

**Q: Can I customize colors?**  
A: Yes, modify Tailwind classes in `EventTickerCard.tsx` or `LiveEventTicker.tsx`.

**Q: How many events can it handle?**  
A: Unlimited, but only shows max 5 cards. Queue stores up to 50 events.

**Q: Does it work on mobile?**  
A: Yes, fully responsive design.

**Q: Can I use it on multiple gameweeks?**  
A: Yes, each page can have its own ticker with different gameweekId.

## Troubleshooting

**Events not showing?**
1. Check if auth token exists: `localStorage.getItem('authToken')`
2. Open DevTools Network tab, look for WebSocket connection
3. Check console for errors
4. Verify gameweekId is correct

**Animations stuttering?**
1. Reduce `maxVisibleEvents` to 3
2. Close other browser tabs
3. Check GPU acceleration enabled

**Connection keeps dropping?**
1. Check internet connection
2. Verify backend WebSocket server running
3. Check firewall settings

## Next Steps

1. ✅ Add to a gameweek/match page
2. ✅ Test with live gameweek events
3. ✅ Customize position and timing
4. ✅ Add custom CSS styling if needed
5. ✅ Deploy to production

## Support

For issues or questions:
- Check `EVENT_TICKER_IMPLEMENTATION.md` for detailed docs
- Review test file for usage examples
- Check `IMPLEMENTATION_CHECKLIST.md` for complete feature list

---

**That's it!** You now have a production-ready live event ticker. Events will stream in real-time as they happen during matches. 🚀
