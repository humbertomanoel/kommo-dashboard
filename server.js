const express = require('express');
const axios = require('axios');
const LRU = require('lru-cache');
const fs = require('fs');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

const KOMMO_TOKEN = process.env.KOMMO_TOKEN;
const KOMMO_SUBDOMAIN = process.env.KOMMO_SUBDOMAIN;
const CACHE_TTL = 60 * 1000;

if (!KOMMO_TOKEN || !KOMMO_SUBDOMAIN) {
  console.error('Missing KOMMO_TOKEN or KOMMO_SUBDOMAIN');
}

// set up LRU cache
const cache = new LRU({ max: 500, ttl: CACHE_TTL });

// JSON middleware
app.use(express.json());

// Content Security Policy and other headers
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', "frame-ancestors 'self' https://*.kommo.com https://kommo.com");
  res.setHeader('X-Robots-Tag', 'noindex');
  next();
});

// Helper to get cached value or fetch new
async function getCached(key, fetchFn) {
  if (cache.has(key)) {
    return cache.get(key);
  }
  const val = await fetchFn();
  cache.set(key, val);
  return val;
}

// Make request to Kommo API with pagination
async function kommoRequest(path, params = {}) {
  const baseUrl = `https://${KOMMO_SUBDOMAIN}.kommo.com/api/v4${path}`;
  const limit = 250;
  let page = 1;
  let results = [];
  while (true) {
    try {
      const response = await axios.get(baseUrl, {
        headers: {
          'Authorization': `Bearer ${KOMMO_TOKEN}`
        },
        params: { ...params, limit, page }
      });
      const data = response.data;
      // leads lists come as array or in _embedded.items
      let items = [];
      if (Array.isArray(data)) {
        items = data;
      } else if (data && data._embedded && Array.isArray(data._embedded.items)) {
        items = data._embedded.items;
      } else {
        return data;
      }
      results = results.concat(items);
      if (items.length < limit) break;
      page += 1;
    } catch (err) {
      if (err.response && (err.response.status === 429 || err.response.status >= 500)) {
        // exponential backoff simple
        await new Promise(res => setTimeout(res, 1000));
        continue;
      }
      console.error(err.response ? err.response.data : err.message);
      throw err;
    }
  }
  return results;
}

// Parse range into start and end dates
function parseRange(range, from, to) {
  const now = new Date();
  let start, end;
  if (range === 'today') {
    start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  } else if (range === 'yesterday') {
    start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  } else if (range === '7d') {
    start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    end = now;
  } else if (range === '30d') {
    start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    end = now;
  } else if (range === 'custom' && from && to) {
    start = new Date(from);
    end = new Date(to);
  } else {
    // default to today
    start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  }
  return { start, end };
}

function toUnix(date) {
  return Math.floor(date.getTime() / 1000);
}

// Simple functions to fetch leads
async function fetchLeads(params) {
  const { start, end, pipeline_id, user_id } = params;
  const query = {};
  query['filter[created_at][from]'] = toUnix(start);
  query['filter[created_at][to]'] = toUnix(end);
  if (pipeline_id) query['filter[pipeline_id]'] = pipeline_id;
  if (user_id) query['filter[responsible_user_id]'] = user_id;
  const leads = await kommoRequest('/leads', query);
  return leads;
}

async function fetchLeadsClosed(params) {
  const { start, end, pipeline_id, user_id } = params;
  const query = {};
  query['filter[closed_at][from]'] = toUnix(start);
  query['filter[closed_at][to]'] = toUnix(end);
  if (pipeline_id) query['filter[pipeline_id]'] = pipeline_id;
  if (user_id) query['filter[responsible_user_id]'] = user_id;
  const leads = await kommoRequest('/leads', query);
  return leads;
}

// Health check
app.get('/healthz', (req, res) => {
  res.json({ status: 'ok' });
});

// Get pipelines
app.get('/api/pipelines', async (req, res) => {
  try {
    const data = await getCached('pipelines', async () => {
      const pipelines = await kommoRequest('/leads/pipelines');
      return pipelines;
    });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch pipelines' });
  }
});

// Get users
app.get('/api/users', async (req, res) => {
  try {
    const data = await getCached('users', async () => {
      const users = await kommoRequest('/users');
      return users;
    });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// /api/metrics
app.get('/api/metrics', async (req, res) => {
  const { range = 'today', from, to, pipeline_id, user_id } = req.query;
  const key = `/metrics?range=${range}&from=${from}&to=${to}&pipeline_id=${pipeline_id}&user_id=${user_id}`;
  try {
    const result = await getCached(key, async () => {
      const { start, end } = parseRange(range, from, to);
      const createdLeads = await fetchLeads({ start, end, pipeline_id, user_id });
      const closedLeads = await fetchLeadsClosed({ start, end, pipeline_id, user_id });
      const wonLeads = closedLeads.filter(l => l.status_id === 142);
      const lostLeads = closedLeads.filter(l => l.status_id === 143);
      const activeLeads = createdLeads.filter(l => l.status_id !== 142 && l.status_id !== 143);
      const leadsCreatedCount = createdLeads.length;
      const leadsWonCount = wonLeads.length;
      const leadsLostCount = lostLeads.length;
      const revenueWon = wonLeads.reduce((sum, l) => sum + (l.price || 0), 0);
      const conversionRate = leadsCreatedCount > 0 ? (leadsWonCount / leadsCreatedCount) * 100 : 0;
      const avgTicket = leadsWonCount > 0 ? (revenueWon / leadsWonCount) : 0;
      return {
        leads_created: leadsCreatedCount,
        leads_won: leadsWonCount,
        leads_lost: leadsLostCount,
        active_leads: activeLeads.length,
        conversion_rate: Number(conversionRate.toFixed(4)),
        revenue_won: revenueWon,
        avg_ticket: Number(avgTicket.toFixed(2)),
        time_to_first_touch_avg_minutes: null
      };
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch metrics' });
  }
});

// /api/funnels
app.get('/api/funnels', async (req, res) => {
  const { pipeline_id, range = 'today', from, to } = req.query;
  const key = `/funnels?pipeline=${pipeline_id}&range=${range}&from=${from}&to=${to}`;
  try {
    const data = await getCached(key, async () => {
      const { start, end } = parseRange(range, from, to);
      const leads = await fetchLeads({ start, end, pipeline_id });
      const stageMap = {};
      for (const lead of leads) {
        let stageName;
        if (lead._embedded && lead._embedded.status) {
          stageName = lead._embedded.status.name;
        } else {
          stageName = String(lead.status_id);
        }
        if (!stageMap[stageName]) {
          stageMap[stageName] = { stage_name: stageName, count: 0, value_sum: 0 };
        }
        stageMap[stageName].count += 1;
        stageMap[stageName].value_sum += lead.price || 0;
      }
      return Object.values(stageMap);
    });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch funnel data' });
  }
});

// /api/timeseries
app.get('/api/timeseries', async (req, res) => {
  const { metric, range = '7d', pipeline_id, user_id } = req.query;
  if (!metric) {
    return res.status(400).json({ error: 'metric is required' });
  }
  const key = `/timeseries?metric=${metric}&range=${range}&pipeline=${pipeline_id}&user_id=${user_id}`;
  try {
    const data = await getCached(key, async () => {
      const { start, end } = parseRange(range);
      const days = Math.ceil((end - start) / (24 * 60 * 60 * 1000));
      const series = {};
      for (let i = 0; i < days; i++) {
        const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
        const keyDate = date.toISOString().slice(0, 10);
        series[keyDate] = 0;
      }
      if (metric === 'leads_created') {
        const leads = await fetchLeads({ start, end, pipeline_id, user_id });
        for (const lead of leads) {
          const d = new Date(lead.created_at * 1000);
          const k = d.toISOString().slice(0, 10);
          if (series[k] !== undefined) series[k] += 1;
        }
      } else if (metric === 'leads_won' || metric === 'revenue_won') {
        const leads = await fetchLeadsClosed({ start, end, pipeline_id, user_id });
        const wonLeads = leads.filter(l => l.status_id === 142);
        for (const lead of wonLeads) {
          const d = new Date(lead.closed_at * 1000);
          const k = d.toISOString().slice(0, 10);
          if (metric === 'leads_won') {
            if (series[k] !== undefined) series[k] += 1;
          } else {
            if (series[k] !== undefined) series[k] += lead.price || 0;
          }
        }
      }
      return Object.keys(series).map(date => ({ date, value: series[date] }));
    });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch timeseries data' });
  }
});

// /api/tasks
app.get('/api/tasks', async (req, res) => {
  const { user_id } = req.query;
  const key = `/tasks?user_id=${user_id}`;
  try {
    const data = await getCached(key, async () => {
      const now = new Date();
      const params = { 'filter[is_completed]': 0 };
      if (user_id) params['filter[responsible_user_id]'] = user_id;
      const tasks = await kommoRequest('/tasks', params);
      let overdue = 0;
      let today = 0;
      let next48h = 0;
      for (const task of tasks) {
        const due = task.complete_till_at ? new Date(task.complete_till_at * 1000) : null;
        if (!due) continue;
        if (due < now) {
          overdue++;
        } else if (
          due.getFullYear() === now.getFullYear() &&
          due.getMonth() === now.getMonth() &&
          due.getDate() === now.getDate()
        ) {
          today++;
        } else if (due - now <= 48 * 60 * 60 * 1000) {
          next48h++;
        }
      }
      return { overdue, today, next48h };
    });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch tasks' });
  }
});

// Serve dashboard HTML
app.get('/dash', (req, res) => {
  fs.readFile(path.join(__dirname, 'dash.html'), 'utf8', (err, data) => {
    if (err) {
      res.status(500).send('Dashboard not found');
    } else {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(data);
    }
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
