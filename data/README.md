# data/

Not used yet. The natural next step is a history of the numbers, one point per day, so the page can show
progress over time: a build step would append `dist/data.json`'s `overall` and `areas` to a file here (committed
by the workflow, or kept on a branch) and the template would draw it. Nothing builds or reads this directory.
