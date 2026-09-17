# The code agent's durable worker.
#
# Deliberately boring, like the deploy plane's image: no build step, no
# compiler in the runtime image, and NO DOCKER CLI — this container must
# never be able to create one. The only thing on the platform that holds
# a Docker socket is the deploy plane's worker, and this process asks it
# over HTTP for a build check rather than doing one itself.
#
# The build context is the REPO ROOT, not this directory, because the
# worker is backend/worker/codeagent-worker.js and requires its way up
# into backend/lib. There is one copy of the agent, not a fork that
# drifts from the one the API runs.
FROM node:20-alpine

WORKDIR /app

# Root manifest: the same one Vercel installs from, so the worker and the
# serverless function resolve identical versions of mongodb, the AI SDKs
# and the rest. A second dependency tree is a second set of behaviours.
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

# Only what the worker actually reaches. Not backend/test, not
# backend/demos, not backend/agent-src — the TypeScript sources compile
# to backend/lib/codeagent and it is the compiled output that runs.
COPY backend/worker ./backend/worker
COPY backend/lib ./backend/lib
COPY backend/db.js ./backend/db.js
COPY backend/package.json ./backend/package.json

# Unprivileged. Unlike the deploy worker there is no socket to reach and
# no reason to be root, so it is not.
USER node

ENV NODE_ENV=production
CMD ["node", "backend/worker/codeagent-worker.js"]
