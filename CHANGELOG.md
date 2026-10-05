# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- A post's lifecycle is draft, discarded, verified, published and retired. Verified replaces Ready, Retired replaces Expired, and Discarded keeps a draft that is not wanted without deleting it.
- The Posts list has a section per status. Discarded, Published and Retired load a page at a time, and the "Posts per load" setting sets the page size of all three; a workspace's `config.json` stores it as `postsPerLoad` in place of `publishedPostsPerLoad`.
- Each status keeps the time the post reached it, and a status that implies an earlier one fills that time too: a published post always has a verification time, and a retired one a publication time. Moving to another status clears the times it does not hold, and moving a retired post back to Published restores its original publication time. Moving a post away from Published or Retired asks first, because its publication time is cleared.
- Locking is a separate toggle beside the status. A locked post's text, metadata, assets and source link cannot be edited; its status can still change and it can still be deleted. Publishing no longer locks a post, and editing no longer needs a move back to an earlier status.
- Post files store `verifiedAtUtc` and `retiredAtUtc` in place of `readyAtUtc` and `expiredAtUtc`, add `discardedAtUtc` and `locked`, and no longer read the `ready` and `expired` statuses.

### Fixed

- A post's updated time changes only when its text, metadata, assets or source link change. Changing its status, locking it, and saving text or metadata equal to what is on disk no longer move it; uploading, replacing or deleting an asset now does.
- An asset found in a post's folder without a record of its upload no longer gets its file's modified time saved as its upload time.

## [0.1.0] - 2026-07-08

### Added

- First public release.
