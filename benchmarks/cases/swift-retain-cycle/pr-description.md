## Summary

Add data loading functionality to ViewController with a delegate-based DataLoader.

## Changes

- ViewController now owns a `DataLoader` as a stored property
- Added `startDataLoading()` that assigns `loader.delegate = self`
- Updated DataLoader with async loading capability

## Testing

Manual testing on iOS simulator.
