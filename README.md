# AI Radar collector

Runs on GitHub Actions every day at 7:38 AM IST (and on demand) and saves raw signals to `data/<date>/`:
YouTube uploads for the 19 tracked channels (RSS), Hacker News, arXiv, Hugging Face, GitHub repos and advisories,
Reddit, lab blogs, security feeds and newsletters. `manifest.json` in each folder lists which sources worked.

Setup: push this folder to a new GitHub repo, then Actions > Collect AI Radar signals > Run workflow.
Edit `channels.json` to add or remove channels.
