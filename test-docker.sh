#!/bin/bash
set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${YELLOW}🐳 Testing Codex MCP Server Docker Image${NC}"
echo ""

# Check if config.env exists
if [[ ! -f "config.env" ]]; then
    echo -e "${RED}❌ config.env file not found!${NC}"
    echo "Please copy config.env and set your OPENAI_API_KEY"
    exit 1
fi

# Load environment variables
source config.env

# Check if OPENAI_API_KEY is set
if [[ -z "${OPENAI_API_KEY:-}" ]] || [[ "${OPENAI_API_KEY}" == "sk-proj-your_openai_api_key_here" ]]; then
    echo -e "${RED}❌ OPENAI_API_KEY not set in config.env!${NC}"
    echo "Please edit config.env and set your real OpenAI API key"
    exit 1
fi

echo -e "${YELLOW}📦 Building Docker image...${NC}"
docker build -t codex-mcp-server .

if [[ $? -eq 0 ]]; then
    echo -e "${GREEN}✅ Docker image built successfully!${NC}"
else
    echo -e "${RED}❌ Docker build failed!${NC}"
    exit 1
fi

echo ""
echo -e "${YELLOW}🧪 Testing Docker image...${NC}"

# Create a test workspace directory
mkdir -p ./test-workspace

# Test 1: Check if container starts properly
echo -e "${YELLOW}Test 1: Container startup test${NC}"
timeout 10s docker run --rm \
    --env-file config.env \
    -v "$(pwd)/test-workspace:/workspace" \
    codex-mcp-server &

CONTAINER_PID=$!
sleep 5

if kill -0 $CONTAINER_PID 2>/dev/null; then
    echo -e "${GREEN}✅ Container starts successfully${NC}"
    kill $CONTAINER_PID 2>/dev/null || true
    wait $CONTAINER_PID 2>/dev/null || true
else
    echo -e "${RED}❌ Container failed to start${NC}"
fi

# Test 2: Check if Codex CLI is available
echo ""
echo -e "${YELLOW}Test 2: Codex CLI availability test${NC}"
CODEX_TEST=$(docker run --rm \
    --env-file config.env \
    -v "$(pwd)/test-workspace:/workspace" \
    codex-mcp-server \
    sh -c "which codex" 2>/dev/null || echo "not found")

if [[ "$CODEX_TEST" == *"codex"* ]]; then
    echo -e "${GREEN}✅ Codex CLI is available in container${NC}"
else
    echo -e "${RED}❌ Codex CLI not found in container${NC}"
fi

# Test 3: Check workspace permissions
echo ""
echo -e "${YELLOW}Test 3: Workspace permissions test${NC}"
WORKSPACE_TEST=$(docker run --rm \
    --env-file config.env \
    -v "$(pwd)/test-workspace:/workspace" \
    codex-mcp-server \
    sh -c "touch /workspace/test-file && echo 'success'" 2>/dev/null || echo "failed")

if [[ "$WORKSPACE_TEST" == "success" ]]; then
    echo -e "${GREEN}✅ Workspace is writable${NC}"
    # Clean up test file
    rm -f ./test-workspace/test-file
else
    echo -e "${RED}❌ Workspace is not writable${NC}"
fi

# Test 4: Node.js and npm versions
echo ""
echo -e "${YELLOW}Test 4: Node.js environment test${NC}"
NODE_VERSION=$(docker run --rm codex-mcp-server node --version)
NPM_VERSION=$(docker run --rm codex-mcp-server npm --version)

echo -e "${GREEN}✅ Node.js version: ${NODE_VERSION}${NC}"
echo -e "${GREEN}✅ npm version: ${NPM_VERSION}${NC}"

# Test 5: MCP SDK availability
echo ""
echo -e "${YELLOW}Test 5: MCP SDK test${NC}"
MCP_TEST=$(docker run --rm \
    codex-mcp-server \
    node -e "try { require('@modelcontextprotocol/sdk/server/index.js'); console.log('success'); } catch(e) { console.log('failed'); }")

if [[ "$MCP_TEST" == "success" ]]; then
    echo -e "${GREEN}✅ MCP SDK is available${NC}"
else
    echo -e "${RED}❌ MCP SDK not found${NC}"
fi

echo ""
echo -e "${YELLOW}📋 Docker Image Info:${NC}"
docker images codex-mcp-server --format "table {{.Repository}}\t{{.Tag}}\t{{.Size}}\t{{.CreatedAt}}"

echo ""
echo -e "${GREEN}🎉 Docker testing completed!${NC}"
echo ""
echo -e "${YELLOW}💡 Usage examples:${NC}"
echo ""
echo "1. Run with Claude Desktop (add to claude_desktop_config.json):"
echo '   {'
echo '     "mcpServers": {'
echo '       "codex": {'
echo '         "command": "docker",'
echo '         "args": ['
echo '           "run", "-i", "--rm",'
echo '           "--env-file", "/path/to/config.env",'
echo '           "-v", "/path/to/workspace:/workspace",'
echo '           "codex-mcp-server"'
echo '         ]'
echo '       }'
echo '     }'
echo '   }'
echo ""
echo "2. Test manually:"
echo "   docker run -i --rm --env-file config.env -v \$(pwd)/test-workspace:/workspace codex-mcp-server"
echo ""
echo "3. Deploy to CapRover:"
echo "   - Create new app"
echo "   - Set environment variables from config.env"
echo "   - Deploy this Docker image"

# Cleanup
rm -rf ./test-workspace
