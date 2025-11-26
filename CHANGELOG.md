# Change Log

All notable changes to the "LogFocus" extension will be documented in this file.

## [Unreleased]

### Added
- Import/Export project functionality - share and backup your filter configurations
- Output Channel for debugging - view filter and cache statistics via "LogFocus: Show Filter and Cache Statistics" command
- Cache statistics API - new `getCacheStats()` method to track filter performance

### Fixed
- Project menu context - Export and Delete commands now only appear on project items
- Color scheme - Swapped normal and exclude filter colors for better visibility (normal filters now use darker colors)
- Settings persistence - Only save immutable properties (name, color) to prevent state corruption
- Project refresh - Properly dispose filter resources when switching projects to prevent memory leaks
- EditorCacheEntry visibility - Exported interface for external access in output logging

## 0.1.0
- Initial release
