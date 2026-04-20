const express = require("express");
const path = require("path");
const { resolveSearchParams } = require("./keywords");
const { createJobId } = require("./worker");
const { createAuth } = require("./auth");
const { writeArtifacts } = require("./exporters");
const { createStatusChecker } = require("./status-checker");

function createApp({ store, config, nocoDb }) {
  const app = express();
  const auth = createAuth({ store, config });

  app.use(express.json({ limit: "1mb" }));
  app.use("/assets", express.static(path.join(__dirname, "..", "public")));

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/", (req, res) => {
    if (!auth.isConfigured()) {
      return res.redirect("/login");
    }

    const session = auth.currentSession(req);
    return res.redirect(session ? "/dashboard" : "/login");
  });

  app.get("/login", (req, res) => {
    if (auth.isConfigured() && auth.currentSession(req)) {
      return res.redirect("/dashboard");
    }

    res.sendFile(path.join(__dirname, "..", "public", "login.html"));
  });

  app.post("/api/auth/login", (req, res) => {
    auth.handleLogin(req, res);
  });

  app.post("/api/auth/logout", withAuth(auth), (req, res) => {
    auth.handleLogout(req, res);
  });

  app.get("/api/auth/session", withAuth(auth), (req, res) => {
    res.json({
      authenticated: true,
      username: req.authSession.username,
      expiresAt: req.authSession.expiresAt,
    });
  });

  app.get("/dashboard", withAuth(auth), (_req, res) => {
    res.sendFile(path.join(__dirname, "..", "public", "dashboard.html"));
  });

  app.get("/integrations/nocodb", withAuth(auth), (_req, res) => {
    res.json(nocoDb.getConfig());
  });

  app.put("/integrations/nocodb", withAuth(auth), (req, res, next) => {
    try {
      res.json(nocoDb.saveConfig(req.body || {}));
    } catch (error) {
      next(error);
    }
  });

  app.post("/integrations/nocodb/test", withAuth(auth), async (req, res, next) => {
    try {
      res.json(await nocoDb.testConnection(req.body || null));
    } catch (error) {
      next(error);
    }
  });

  app.use("/jobs", withAuth(auth));
  app.use("/tools", withAuth(auth));

  app.get("/jobs", (_req, res) => {
    res.json({ jobs: store.listJobs() });
  });

  app.post("/jobs", async (req, res, next) => {
    try {
      const country = String(req.body.country || "").trim();
      const keyword = String(req.body.keyword || "").trim();
      const searchParams = resolveSearchParams(keyword, {
        comprehensiveMode: req.body.comprehensiveMode,
        proxies: req.body.proxies,
      });

      if (!country || !keyword) {
        return res.status(400).json({
          error: "country and keyword are required.",
        });
      }

      const id = createJobId();
      store.createJob({ id, country, keyword, searchParams });

      return res.status(202).json({
        job: store.getJob(id),
        links: buildLinks(req, config, id),
      });
    } catch (error) {
      return next(error);
    }
  });

  app.get("/jobs/:jobId", (req, res) => {
    const job = store.getJob(req.params.jobId);
    if (!job) {
      return res.status(404).json({ error: "Job not found." });
    }

    return res.json({
      job,
      stats: store.getJobStats(job.id),
      links: buildLinks(req, config, job.id),
    });
  });

  app.get("/jobs/:jobId/stats", (req, res) => {
    const job = store.getJob(req.params.jobId);
    if (!job) {
      return res.status(404).json({ error: "Job not found." });
    }

    return res.json({
      job,
      stats: store.getJobStats(job.id),
      links: buildLinks(req, config, job.id),
    });
  });

  app.get("/jobs/:jobId/shards", (req, res) => {
    const job = store.getJob(req.params.jobId);
    if (!job) {
      return res.status(404).json({ error: "Job not found." });
    }

    const limit = Math.min(
      Math.max(Number.parseInt(req.query.limit, 10) || 100, 1),
      1000
    );
    const offset = Math.max(Number.parseInt(req.query.offset, 10) || 0, 0);
    const status = req.query.status ? String(req.query.status).trim() : null;

    return res.json({
      jobId: job.id,
      status,
      limit,
      offset,
      total: store.countJobShards(job.id, status),
      shards: store.listJobShards(job.id, { status, limit, offset }),
    });
  });

  app.get("/jobs/:jobId/errors", (req, res) => {
    const job = store.getJob(req.params.jobId);
    if (!job) {
      return res.status(404).json({ error: "Job not found." });
    }

    const limit = Math.min(
      Math.max(Number.parseInt(req.query.limit, 10) || 25, 1),
      250
    );

    return res.json({
      jobId: job.id,
      limit,
      errors: store.getJobErrors(job.id, { limit }),
    });
  });

  app.get("/jobs/:jobId/leads", (req, res) => {
    const job = store.getJob(req.params.jobId);
    if (!job) {
      return res.status(404).json({ error: "Job not found." });
    }

    const limit = Math.min(Number.parseInt(req.query.limit, 10) || 100, 1000);
    const offset = Math.max(Number.parseInt(req.query.offset, 10) || 0, 0);

    return res.json({
      jobId: job.id,
      limit,
      offset,
      leads: store.getJobLeads(job.id, { limit, offset }),
    });
  });

  app.post("/jobs/:jobId/backfill-statuses", async (req, res, next) => {
    const job = store.getJob(req.params.jobId);
    if (!job) {
      return res.status(404).json({ error: "Job not found." });
    }

    try {
      const runtimeConfig = resolveStatusRuntimeConfig(config, req.body || {});
      const statusChecker = createStatusChecker({ config: runtimeConfig });
      if (!statusChecker.isConfigured()) {
        return res.status(400).json({
          error:
            "No browser executable found. Set STATUS_CHECK_BROWSER_PATH or GOOGLE_CHROME_PATH.",
        });
      }

      const limit = clampInt(req.body?.limit, 25, 1, 500);
      const offset = clampInt(req.body?.offset, 0, 0, 1000000);
      const onlyMissingStatus = req.body?.onlyMissingStatus !== false;
      const targets = store.getStatusCheckTargets(job.id, {
        limit,
        offset,
        onlyMissingStatus,
      });
      const results = await statusChecker.checkLeads(targets, req.body || {});

      for (const result of results) {
        if (result.leadId && !["failed", "skipped"].includes(result.status)) {
          store.updateLeadStatusRecovery(result.leadId, {
            status: result.status,
            link: result.link,
          });
        }
      }

      const artifacts = writeArtifacts(store, config, job.id);
      store.updateJobArtifacts(job.id, artifacts);

      return res.json({
        jobId: job.id,
        onlyMissingStatus,
        limit,
        offset,
        processed: results.length,
        summary: summarizeStatusResults(results),
        results,
        stats: store.getJobStats(job.id),
        links: buildLinks(req, config, job.id),
      });
    } catch (error) {
      return next(error);
    }
  });

  app.post("/jobs/:jobId/cancel", (req, res) => {
    const job = store.getJob(req.params.jobId);
    if (!job) {
      return res.status(404).json({ error: "Job not found." });
    }

     if (["completed", "partial", "failed", "canceled"].includes(job.status)) {
      return res.status(409).json({
        error: `Job is already ${job.status}.`,
      });
    }

    const canceledJob = store.cancelJob(job.id);
    return res.json({
      job: canceledJob,
      stats: store.getJobStats(job.id),
      links: buildLinks(req, config, job.id),
    });
  });

  app.post("/jobs/:jobId/pause", (req, res) => {
    const job = store.getJob(req.params.jobId);
    if (!job) {
      return res.status(404).json({ error: "Job not found." });
    }

    if (job.status === "paused") {
      return res.status(409).json({ error: "Job is already paused." });
    }

    if (["completed", "partial", "failed", "canceled"].includes(job.status)) {
      return res.status(409).json({
        error: `Job is already ${job.status}.`,
      });
    }

    const pausedJob = store.pauseJob(job.id);
    return res.json({
      job: pausedJob,
      stats: store.getJobStats(job.id),
      links: buildLinks(req, config, job.id),
    });
  });

  app.post("/jobs/:jobId/resume", (req, res) => {
    const job = store.getJob(req.params.jobId);
    if (!job) {
      return res.status(404).json({ error: "Job not found." });
    }

    if (job.status !== "paused") {
      return res.status(409).json({
        error: "Only paused jobs can be resumed.",
      });
    }

    const resumedJob = store.resumeJob(job.id);
    return res.json({
      job: resumedJob,
      stats: store.getJobStats(job.id),
      links: buildLinks(req, config, job.id),
    });
  });

  app.delete("/jobs/:jobId", (req, res, next) => {
    try {
      const job = store.getJob(req.params.jobId);
      if (!job) {
        return res.status(404).json({ error: "Job not found." });
      }

      const deletedJob = store.deleteJob(job.id);
      return res.json({
        ok: true,
        deletedJob,
      });
    } catch (error) {
      return next(error);
    }
  });

  app.get("/jobs/:jobId/sync/nocodb", (req, res) => {
    const job = store.getJob(req.params.jobId);
    if (!job) {
      return res.status(404).json({ error: "Job not found." });
    }

    return res.json({
      jobId: job.id,
      ...nocoDb.getJobSyncStatus(job.id),
    });
  });

  app.post("/jobs/:jobId/sync/nocodb", async (req, res, next) => {
    const job = store.getJob(req.params.jobId);
    if (!job) {
      return res.status(404).json({ error: "Job not found." });
    }

    try {
      const result = await nocoDb.syncJob(job.id, {
        force: Boolean(req.body?.force),
      });

      return res.json(result);
    } catch (error) {
      return next(error);
    }
  });

  app.get("/jobs/:jobId/download", (req, res) => {
    const job = store.getJob(req.params.jobId);
    if (!job) {
      return res.status(404).json({ error: "Job not found." });
    }

    const format = (req.query.format || "csv").toString().toLowerCase();
    const filePath =
      format === "json" ? job.artifactJsonPath : job.artifactCsvPath;

    if (!filePath) {
      return res.status(409).json({
        error: "Artifacts are not ready yet.",
        jobStatus: job.status,
      });
    }

    return res.download(filePath);
  });

  app.use((error, _req, res, _next) => {
    const statusCode = error.statusCode || 500;
    res.status(statusCode).json({
      error: error.message || "Unexpected error.",
    });
  });

  return app;
}

function withAuth(auth) {
  return (req, res, next) => auth.requireAuth(req, res, next);
}

function buildLinks(req, config, jobId) {
  const baseUrl =
    config.publicBaseUrl || `${req.protocol}://${req.get("host")}`;

  return {
    self: `${baseUrl}/jobs/${jobId}`,
    dashboard: `${baseUrl}/dashboard?jobId=${jobId}`,
    stats: `${baseUrl}/jobs/${jobId}/stats`,
    shards: `${baseUrl}/jobs/${jobId}/shards`,
    errors: `${baseUrl}/jobs/${jobId}/errors`,
    leads: `${baseUrl}/jobs/${jobId}/leads`,
    backfillStatuses: `${baseUrl}/jobs/${jobId}/backfill-statuses`,
    csv: `${baseUrl}/jobs/${jobId}/download?format=csv`,
    json: `${baseUrl}/jobs/${jobId}/download?format=json`,
    cancel: `${baseUrl}/jobs/${jobId}/cancel`,
    pause: `${baseUrl}/jobs/${jobId}/pause`,
    resume: `${baseUrl}/jobs/${jobId}/resume`,
    delete: `${baseUrl}/jobs/${jobId}`,
    nocodbSync: `${baseUrl}/jobs/${jobId}/sync/nocodb`,
  };
}

function resolveStatusRuntimeConfig(config, body) {
  return {
    ...config,
    statusCheckBrowserPath:
      cleanString(body.browserPath) || config.statusCheckBrowserPath,
    statusCheckTimeoutMs: clampInt(
      body.timeoutMs,
      config.statusCheckTimeoutMs,
      5000,
      120000
    ),
    statusCheckConcurrency: clampInt(
      body.concurrency,
      config.statusCheckConcurrency,
      1,
      8
    ),
  };
}

async function runWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  const runners = Array.from(
    { length: Math.min(Math.max(concurrency, 1), items.length || 1) },
    async () => {
      while (true) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) {
          break;
        }
        results[index] = await worker(items[index], index);
      }
    }
  );

  await Promise.all(runners);
  return results;
}

function summarizeStatusResults(results) {
  return results.reduce((summary, result) => {
    summary[result.status] = (summary[result.status] || 0) + 1;
    return summary;
  }, {});
}

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? fallback), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(Math.max(parsed, min), max);
}

function cleanString(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

module.exports = {
  createApp,
};
