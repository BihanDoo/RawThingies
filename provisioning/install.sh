#!/usr/bin/env bash
set -e

echo "=========================================="
echo " Raw Thingies - Provisioning Script"
echo "=========================================="

if [[ $EUID -ne 0 ]]; then
   echo "This script must be run as root (e.g. sudo ./install.sh)" 
   exit 1
fi

echo "[1/9] Updating system packages..."
apt-get update -y
apt-get upgrade -y
apt-get install -y curl wget git unzip software-properties-common ufw fail2ban

echo "[2/9] Installing Node.js (v20 LTS)..."
if ! command -v node > /dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
else
    echo "Node.js already installed."
fi

echo "[3/9] Installing PM2 and dependencies..."
if ! command -v pm2 > /dev/null; then
    npm install -g pm2
    pm2 install pm2-logrotate
    # We run startup for root so PM2 starts on boot
    env PATH=$PATH:/usr/bin pm2 startup systemd -u root --hp /root
    pm2 save
else
    echo "PM2 already installed."
fi

echo "[4/9] Installing Nginx and Certbot..."
apt-get install -y nginx certbot python3-certbot-nginx
systemctl enable nginx
systemctl start nginx

echo "[5/9] Installing MongoDB..."
# For Ubuntu 22.04/24.04, gnupg is needed
apt-get install -y gnupg
if ! command -v mongod > /dev/null; then
    curl -fsSL https://www.mongodb.org/static/pgp/server-7.0.asc | \
        gpg -o /usr/share/keyrings/mongodb-server-7.0.gpg \
        --dearmor --yes
    echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-7.0.gpg ] https://repo.mongodb.org/apt/ubuntu jammy/mongodb-org/7.0 multiverse" | tee /etc/apt/sources.list.d/mongodb-org-7.0.list
    apt-get update -y
    apt-get install -y mongodb-org
    systemctl enable mongod
    systemctl start mongod
else
    echo "MongoDB already installed."
fi

echo "[6/9] Installing PHP-FPM and MariaDB (for WordPress)..."
apt-get install -y php-fpm php-mysql mariadb-server
systemctl enable php$(php -r 'echo PHP_MAJOR_VERSION.".".PHP_MINOR_VERSION;')-fpm
systemctl start php$(php -r 'echo PHP_MAJOR_VERSION.".".PHP_MINOR_VERSION;')-fpm
systemctl enable mariadb
systemctl start mariadb

echo "[7/9] Installing WP-CLI..."
if ! command -v wp > /dev/null; then
    curl -O https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar
    chmod +x wp-cli.phar
    mv wp-cli.phar /usr/local/bin/wp
else
    echo "WP-CLI already installed."
fi

echo "[8/9] Configuring Firewall (UFW) and Fail2ban..."
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
systemctl enable fail2ban
systemctl start fail2ban

echo "[9/9] Creating Raw Thingies master key for encryption..."
mkdir -p /etc/raw-thingies
if [ ! -f /etc/raw-thingies/master.key ]; then
    # Generate a random 32-byte hex key
    openssl rand -hex 32 > /etc/raw-thingies/master.key
    chmod 600 /etc/raw-thingies/master.key
    echo "Master key generated at /etc/raw-thingies/master.key"
else
    echo "Master key already exists."
fi

# Ensure base apps directory exists, owned by whoever runs the Raw Thingies
# control plane (the sudo caller) so the deploy pipeline can write releases
# into it without running as root.
mkdir -p /var/www/apps
chmod 755 /var/www/apps
if [ -n "$SUDO_USER" ]; then
    chown -R "$SUDO_USER:$SUDO_USER" /var/www/apps
fi

echo "=========================================="
echo " Provisioning complete."
echo "=========================================="
