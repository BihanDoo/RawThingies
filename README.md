# Raw Thingies

This is a self-hosted Raw Services deployment service like PM2, Nginx etc.  
this is still in development. 




Make the raw command available globally
Currently, the package.json doesn't have a "bin" field configured to expose the CLI globally. You can manually link the executable to your system path so you can type raw from anywhere:

```
chmod +x cli/raw.js
sudo ln -s $(pwd)/cli/raw.js /usr/local/bin/raw
```
