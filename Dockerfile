FROM node:24-bookworm-slim AS runtime

ENV DEBIAN_FRONTEND=noninteractive \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    PI_SKIP_VERSION_CHECK=1 \
    PI_TELEMETRY=0

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    git \
    openssh-client \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.5.1 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json README.md ./
COPY docs ./docs
COPY scripts ./scripts
COPY src ./src

RUN pnpm typecheck && pnpm typecheck:web && pnpm build

VOLUME ["/data/tasksmith"]
EXPOSE 3000

CMD ["pnpm", "start"]
