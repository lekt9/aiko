# Edge matrix — Hoysan Drop-In

- auth: no session 401, bad PIN 401, good PIN 200, logout 200
- crud create: valid worker 201, missing name 400, duplicate 409 if unique
- crud read: list empty 200, list seeded 200, get 404
- crud update: patch field 200, patch missing id 404
- crud delete: delete 200, deleted not in list 404
- primary surface: loads Excel grid, muscle-memory frozen panes, cell toggle
- immutability: published roster 409 on re-level, draft allows
- limbs: /api/limbs 200, escalation advance 200, bad id 404
- concurrency: double create idempotent
- edge: 5-day fence, demand 40, LD tiers 60/180
