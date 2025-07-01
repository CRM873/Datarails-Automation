// api/search-any-files.js - Look for ANY files in the system
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { sftpUsername, serverUrl, exportId } = req.body;
  
  try {
    if (!sftpUsername || !serverUrl || !exportId) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required SFTP configuration' 
      });
    }

    const privateKey = process.env.TOAST_SSH_PRIVATE_KEY;
    if (!privateKey) {
      return res.status(400).json({ 
        success: false, 
        error: 'SSH key not found in environment variables' 
      });
    }

    const { default: SftpClient } = await import('ssh2-sftp-client');
    const sftp = new SftpClient();
    
    try {
      let cleanKey = privateKey.trim();
      if (!cleanKey.includes('-----BEGIN') && !cleanKey.includes('-----END')) {
        cleanKey = `-----BEGIN OPENSSH PRIVATE KEY-----\n${cleanKey}\n-----END OPENSSH PRIVATE KEY-----`;
      }
      cleanKey = cleanKey.replace(/\\n/g, '\n');
      
      const connectionConfigs = [
        {
          host: serverUrl,
          username: sftpUsername,
          privateKey: Buffer.from(cleanKey),
          algorithms: {
            kex: ['diffie-hellman-group14-sha256', 'diffie-hellman-group16-sha512'],
            cipher: ['aes128-ctr', 'aes192-ctr', 'aes256-ctr'],
            serverHostKey: ['ssh-rsa', 'ssh-ed25519'],
            hmac: ['hmac-sha2-256', 'hmac-sha2-512']
          }
        },
        {
          host: serverUrl,
          username: sftpUsername,
          privateKey: cleanKey,
          algorithms: {
            kex: ['diffie-hellman-group14-sha256'],
            cipher: ['aes128-ctr'],
            serverHostKey: ['ssh-rsa'],
            hmac: ['hmac-sha2-256']
          }
        }
      ];

      let connectionError;
      let connected = false;

      for (let i = 0; i < connectionConfigs.length; i++) {
        try {
          await sftp.connect(connectionConfigs[i]);
          connected = true;
          break;
        } catch (err) {
          connectionError = err;
          await sftp.end();
          continue;
        }
      }

      if (!connected) {
        throw connectionError;
      }
      
      // Search EVERYWHERE for any files
      const searchPaths = [
        '/',                                      // Root directory
        `/${exportId}/`,                          // Main export directory
        `/exports/`,                              // Exports folder
        `/data/`,                                 // Data folder
        `/files/`,                                // Files folder
        `/reports/`,                              // Reports folder
      ];

      // Add date-based paths for the last 30 days
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      
      for (let d = new Date(thirtyDaysAgo); d <= new Date(); d.setDate(d.getDate() + 1)) {
        const yyyymmdd = d.getFullYear() + 
                         String(d.getMonth() + 1).padStart(2, '0') + 
                         String(d.getDate()).padStart(2, '0');
        searchPaths.push(`/${exportId}/${yyyymmdd}/`);
        searchPaths.push(`/exports/${exportId}/${yyyymmdd}/`);
        searchPaths.push(`/data/${exportId}/${yyyymmdd}/`);
      }

      let allFiles = [];
      let foundPaths = [];
      let searchResults = [];

      // Check each possible path
      for (const path of searchPaths) {
        try {
          const files = await sftp.list(path);
          if (files && files.length > 0) {
            foundPaths.push(path);
            searchResults.push({
              path: path,
              fileCount: files.length,
              files: files.slice(0, 10).map(f => ({
                name: f.name,
                size: f.size,
                type: f.type,
                modified: new Date(f.modifyTime).toLocaleString()
              }))
            });
            
            const filesWithPath = files.map(file => ({
              ...file,
              fullPath: path + file.name,
              searchPath: path
            }));
            
            allFiles = allFiles.concat(filesWithPath);
          }
        } catch (e) {
          // Path doesn't exist or no access, continue
          continue;
        }
      }

      // Look for CSV files specifically
      const csvFiles = allFiles.filter(file => 
        file.name && file.name.toLowerCase().includes('.csv')
      );

      // Look for any export-related files
      const exportFiles = allFiles.filter(file => 
        file.name && (
          file.name.toLowerCase().includes('export') ||
          file.name.toLowerCase().includes('report') ||
          file.name.toLowerCase().includes('order') ||
          file.name.toLowerCase().includes('sales')
        )
      );

      await sftp.end();
      
      res.status(200).json({ 
        success: true, 
        message: 'Comprehensive file search completed',
        searchInfo: {
          pathsSearched: searchPaths.length,
          pathsWithFiles: foundPaths.length,
          totalFilesFound: allFiles.length
        },
        results: {
          foundPaths: foundPaths,
          csvFiles: csvFiles.length,
          exportRelatedFiles: exportFiles.length,
          searchResults: searchResults
        },
        files: {
          csvFiles: csvFiles.slice(0, 10).map(f => ({
            name: f.name,
            path: f.searchPath,
            size: f.size,
            modified: new Date(f.modifyTime).toLocaleString()
          })),
          exportFiles: exportFiles.slice(0, 10).map(f => ({
            name: f.name,
            path: f.searchPath,
            size: f.size,
            modified: new Date(f.modifyTime).toLocaleString()
          })),
          allFiles: allFiles.slice(0, 20).map(f => ({
            name: f.name,
            path: f.searchPath,
            size: f.size,
            type: f.type,
            modified: new Date(f.modifyTime).toLocaleString()
          }))
        }
      });
      
    } catch (connectionError) {
      await sftp.end();
      throw connectionError;
    }
    
  } catch (error) {
    console.error('Comprehensive search error:', error);
    res.status(500).json({ 
      success: false, 
      error: `File search failed: ${error.message}`,
      details: {
        server: serverUrl,
        username: sftpUsername,
        exportId: exportId
      }
    });
  }
}
