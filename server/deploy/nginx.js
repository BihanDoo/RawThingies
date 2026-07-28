const fs = require('fs');

module.exports = {
  generate(app, plugin, currentReleasePath) {
    const typeSpecificBlock = plugin.nginxConfig(app);
    let innerBlock = typeSpecificBlock.replace(/{{currentReleasePath}}/g, currentReleasePath);
    innerBlock = innerBlock.replace(/{{appSlug}}/g, app.name);

    const certExists = fs.existsSync(`/etc/letsencrypt/live/${app.domain}/fullchain.pem`);

    if (certExists) {
      return `
server {
    listen 80;
    server_name ${app.domain};
    location /.well-known/acme-challenge/ { root /var/www/certbot; }
    location / { return 301 https://$host$request_uri; }
}

server {
    listen 443 ssl http2;
    server_name ${app.domain};
    ssl_certificate     /etc/letsencrypt/live/${app.domain}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${app.domain}/privkey.pem;

    ${innerBlock}
}
`;
    } else {
      // HTTP only if cert doesn't exist yet
      return `
server {
    listen 80;
    server_name ${app.domain};
    location /.well-known/acme-challenge/ { root /var/www/certbot; }

    ${innerBlock}
}
`;
    }
  }
};
