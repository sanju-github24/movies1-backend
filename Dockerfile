# Use Microsoft's official container pre-loaded with all Linux system dependencies
FROM mcr.microsoft.com/playwright/python:v1.45.0-jammy

# Set container working directory
WORKDIR /app

# Install Node.js & NPM (required since your project uses 'npm install')
RUN apt-get update && apt-get install -y nodejs npm && rm -rf /var/lib/apt/lists/*

# Copy requirements and install python backend components
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the rest of your system application code
COPY . .

# Expose your app's port (Render reads this automatically)
EXPOSE 10000

# Start your server (Replace 'main:app' with your actual entrypoint, e.g., 'app:app' or 'server:app')
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "10000", "--timeout-keep-alive", "60"]