#!/usr/bin/env bash
set -euo pipefail
cd /home/mobrienv/projects/pi-gemini-search

pi -e ./extensions/gemini-search/index.ts --no-session "Use gemini_search with question 'What is the latest stable npm version?' as_of_period 'early' as_of_year 2026 timeout_sec 180 max_sources 3. Return a short answer."
