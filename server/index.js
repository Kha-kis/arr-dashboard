const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;
const isProduction = process.env.NODE_ENV === 'production';

// Security middleware
if (isProduction) {
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'"],
      },
    },
  }));
}

// Rate limiting for API proxy
const proxyLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000, // 15 minutes
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100, // limit each IP to 100 requests per windowMs
  message: {
    error: 'Too many API requests, please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Enable CORS for your React app
const corsOrigins = process.env.CORS_ORIGIN 
  ? process.env.CORS_ORIGIN.split(',')
  : [
      'http://localhost:3000',
      'http://localhost:5173', // Vite dev server
      'http://127.0.0.1:3000',
      'http://127.0.0.1:5173',
    ];

// In development, allow any local IP for WSL/Docker networking
if (!isProduction) {
  corsOrigins.push(/^http:\/\/.*:3000$/, /^http:\/\/.*:5173$/);
}

app.use(
  cors({
    origin: corsOrigins,
    credentials: true,
  })
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Handle preflight OPTIONS requests explicitly
app.options('/api/proxy', cors());
app.options('*', cors());

// Serve static files in production
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../dist')));
}

// Generic proxy endpoint with rate limiting
app.all('/api/proxy', proxyLimiter, async (req, res) => {
  try {
    const { url, apiKey } = req.query;

    if (!url) {
      return res.status(400).json({ error: 'Missing URL parameter' });
    }

    console.log(`Proxying ${req.method} request to: ${url}`);

    const response = await fetch(url, {
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': apiKey || req.headers['x-api-key'],
        ...req.headers,
      },
      body: req.method !== 'GET' ? JSON.stringify(req.body) : undefined,
    });

    const data = await response.text();

    res.status(response.status);
    res.set(
      'Content-Type',
      response.headers.get('content-type') || 'application/json'
    );

    try {
      // Try to parse as JSON
      const jsonData = JSON.parse(data);
      res.json(jsonData);
    } catch {
      // Return as text if not JSON
      res.send(data);
    }
  } catch (error) {
    console.error('Proxy error:', error);
    res.status(500).json({
      error: 'Proxy request failed',
      details: error.message,
    });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Catch all for React app in production
if (process.env.NODE_ENV === 'production') {
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../dist/index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`🚀 *arr Dashboard ${isProduction ? 'Production' : 'Development'} Server`);
  console.log(`📊 Server running on port ${PORT}`);
  console.log(`📡 API proxy endpoint: http://localhost:${PORT}/api/proxy`);
  console.log(`🌐 Health check: http://localhost:${PORT}/api/health`);
  
  if (isProduction) {
    console.log(`🌍 Serving static files from: ${path.join(__dirname, '../dist')}`);
    console.log(`🔒 Security features enabled (Helmet, Rate limiting)`);
  } else {
    console.log(`⚠️  Development mode - CORS and security relaxed`);
  }
  
  console.log(`\n🎯 Ready for *arr services! Configure your Sonarr/Radarr/Prowlarr in the UI.`);
});
