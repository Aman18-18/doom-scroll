# Scroll Tracker

A lightweight browser extension for tracking how many YouTube Shorts and Instagram Reels you watch each day.

![Scroll Tracker App Icon](icons/image.png)

## Overview

Scroll Tracker helps you become more aware of your short-form video habits by counting the number of videos you watch and showing your daily trends in a simple dashboard.

## Screenshots

![Dashboard View](icons/Screenshot%202026-08-15%20233840.png)

![Usage Tracking View](icons/Screenshot%202026-08-15%20233955.png)

## Features

- Tracks daily YouTube Shorts and Instagram Reels activity
- Stores usage locally in your browser
- Displays daily totals in a dashboard
- Helps identify scrolling patterns over time
- Lightweight and easy to run as a browser extension

## Installation

1. Clone or download this repository.
2. Open Chrome or Edge.
3. Go to `chrome://extensions` or `edge://extensions`.
4. Turn on Developer mode.
5. Click `Load unpacked`.
6. Select the project folder.

## Project Structure

- `background.js` – background task handling
- `content.js` – watches page activity for supported sites
- `dashboard.html` / `dashboard.js` – daily analytics dashboard
- `popup.html` / `popup.js` – extension popup UI
- `manifest.json` – browser extension configuration
- `icons/` – extension assets and app icon

## Privacy

This extension stores usage data locally in the browser and does not require external accounts or cloud syncing.

## License

This project is provided as-is for personal and educational use.
