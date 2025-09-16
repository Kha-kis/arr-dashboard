# *arr Dashboard v1.0.0

![Version](https://img.shields.io/badge/version-1.0.0-blue.svg)
![License](https://img.shields.io/badge/license-MIT-green.svg)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20macOS-lightgrey.svg)
![Docker](https://img.shields.io/badge/docker-supported-blue.svg)

A modern, unified web dashboard for managing your *arr stack (Sonarr, Radarr, Prowlarr) with a beautiful interface and real-time monitoring capabilities.

## ✨ Features

- **🎯 Unified Interface** - Manage all your *arr services from one dashboard
- **📊 Real-time Monitoring** - Live status updates and activity feeds
- **🎨 Modern UI** - Clean, responsive design with dark/light themes
- **🔧 Easy Setup** - Quick configuration with desktop shortcuts
- **🐳 Docker Ready** - Full Docker and Docker Compose support
- **🖥️ Cross-Platform** - Works on Windows, Linux, and macOS
- **⚡ Background Service** - Run as system service or background process
- **📱 Mobile Friendly** - Responsive design for mobile access

## 🚀 Quick Start

### Prerequisites
- **Node.js** 18+ and **npm**
- Running instances of Sonarr, Radarr, and/or Prowlarr
- API keys for your *arr services

### Installation

1. **Clone or download this repository**
   ```bash
   git clone https://github.com/your-username/arr-dashboard.git
   cd arr-dashboard
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Create desktop shortcuts** (Windows - recommended)
   ```bash
   npm run create-shortcuts
   ```

4. **Start the dashboard**
   - **Windows**: Double-click "Start arr Dashboard" shortcut
   - **Linux/macOS**: `./start-background.sh`
   - **Development**: `npm start`
   - **Production**: `npm run serve`

5. **Configure services**
   - Open http://localhost:3000
   - Click **Settings** → **Services**
   - Add your Sonarr/Radarr/Prowlarr URLs and API keys

## 📋 Available Commands

### Development
| Command | Description |
|---------|-------------|
| `npm start` | Development mode with hot reload |
| `npm run build` | Build for production |
| `npm run serve` | Production mode |

### Desktop Integration (Windows)
| Command | Description |
|---------|-------------|
| `npm run create-shortcuts` | Create desktop shortcuts |
| `start-background.bat` | Start dashboard in background |
| `stop-dashboard.bat` | Stop background dashboard |

### Cross-Platform Scripts
| Command | Description |
|---------|-------------|
| `./start-background.sh` | Start on Linux/macOS |
| `./stop-dashboard.sh` | Stop on Linux/macOS |

### Docker Commands
| Command | Description |
|---------|-------------|
| `npm run docker:build` | Build Docker image |
| `npm run docker:run` | Run container |
| `npm run docker:stop` | Stop and remove container |
| `npm run docker:logs` | View container logs |
| `npm run docker:compose` | Start with Docker Compose |
| `npm run docker:compose:down` | Stop Docker Compose |
| `npm run docker:compose:logs` | View Compose logs |

## 🐳 Docker Deployment

### Option 1: Simple Docker Container
```bash
# Build and run
npm run docker:build
npm run docker:run

# Access at http://localhost:3000
```

### Option 2: Docker Compose (Dashboard Only)
```bash
# Start dashboard
docker-compose up -d

# View logs
docker-compose logs -f

# Stop
docker-compose down
```

### Option 3: Full *arr Stack (Recommended)
Deploy the complete *arr ecosystem with one command:

```bash
docker-compose -f docker-compose.full-stack.yml up -d
```

**Includes:**
- **arr-dashboard** (port 3000) - This dashboard
- **Prowlarr** (port 9696) - Indexer management
- **Sonarr** (port 8989) - TV series automation
- **Radarr** (port 7878) - Movie automation
- **qBittorrent** (port 8080) - Download client

**Default Credentials:**
- qBittorrent: `admin` / `adminpass`
- Other services: Configure on first run

### Environment Configuration
Create a `.env` file to customize settings:

```env
# Dashboard
PORT=3000
NODE_ENV=production

# Full Stack (for full-stack.yml)
PUID=1000          # Your user ID (run: id -u)
PGID=1000          # Your group ID (run: id -g)
TZ=America/New_York
CONFIG_PATH=./config
DOWNLOADS_PATH=./downloads
MEDIA_PATH=./media
```

## 🔧 Platform-Specific Setup

### Windows
1. Run `npm run create-shortcuts` to create desktop shortcuts
2. Use "Start arr Dashboard" to launch
3. Use "Stop arr Dashboard" to stop
4. Dashboard runs in background automatically

### Linux/macOS
1. Make scripts executable: `chmod +x *.sh`
2. Start: `./start-background.sh`
3. Stop: `./stop-dashboard.sh`
4. View logs: `tail -f dashboard.log`

### Linux Systemd Service
Run as a system service for automatic startup:

```bash
# Edit arr-dashboard.service - update paths and username
sudo cp arr-dashboard.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable arr-dashboard
sudo systemctl start arr-dashboard

# Check status
sudo systemctl status arr-dashboard

# View logs
sudo journalctl -u arr-dashboard -f
```

## ⚙️ Configuration

### Service Configuration
1. Open the dashboard at http://localhost:3000
2. Click **Settings** in the sidebar
3. Add your services:
   - **Sonarr**: `http://localhost:8989` + API key
   - **Radarr**: `http://localhost:7878` + API key  
   - **Prowlarr**: `http://localhost:9696` + API key

### Finding API Keys
- **Sonarr/Radarr**: Settings → General → Security → API Key
- **Prowlarr**: Settings → General → Security → API Key

### Custom Port
To run on a different port:
```bash
# Set in .env file
PORT=8080

# Or use environment variable
PORT=8080 npm run serve
```

## 📁 Project Structure

```
arr-dashboard/
├── src/                    # React frontend source
├── server/                 # Express backend
├── dist/                   # Built frontend files
├── *.bat                   # Windows batch scripts
├── *.sh                    # Linux/macOS shell scripts  
├── *.service              # Systemd service file
├── docker-compose*.yml    # Docker Compose configs
├── Dockerfile             # Docker image config
└── package.json           # Dependencies and scripts
```

## 🛠️ Development

### Local Development
```bash
npm start                   # Start dev server with hot reload
# Frontend: http://localhost:5173
# Backend: http://localhost:3000
```

### Building
```bash
npm run build               # Build for production
npm run serve               # Serve production build
```

### Tech Stack
- **Frontend**: React 18, TypeScript, Tailwind CSS, Vite
- **Backend**: Node.js, Express
- **State**: Zustand, TanStack Query
- **UI**: Lucide Icons, Framer Motion, Recharts

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/amazing-feature`
3. Commit changes: `git commit -m 'Add amazing feature'`
4. Push to branch: `git push origin feature/amazing-feature`
5. Open a Pull Request

## 📝 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🆘 Support

- **Issues**: Report bugs and request features on [GitHub Issues](https://github.com/your-username/arr-dashboard/issues)
- **Discussions**: Join conversations on [GitHub Discussions](https://github.com/your-username/arr-dashboard/discussions)

## 🙏 Acknowledgments

- The *arr community for building amazing automation tools
- LinuxServer.io for excellent Docker images
- All contributors who help improve this project

---

⭐ **Star this repo** if you find it useful!
