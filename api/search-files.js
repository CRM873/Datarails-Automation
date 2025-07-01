// api/search-files.js
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

  const { sftpUsername, serverUrl, exportId, sshKeyContent, startDate, endDate } = req.body;
  
  try {
    if (!sftpUsername || !serverUrl || !exportId || !sshKeyContent) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required SFTP configuration' 
      });
    }

    const { default: SftpClient } = await import('ssh2-sftp-client');
    const sftp = new SftpClient();
    
    try {
      // Parse date range
      const start = startDate ? new Date(startDate) : new Date('2025-06-23');
      const end = endDate ? new Date(endDate) : new Date('2025-06-30');
      
      // Connect to SFTP
      let cleanKey = sshKeyContent.trim().replace(/\\n/g, '\n');
      
      await sftp.connect({
        host: serverUrl,
        username: sftpUsername,
        privateKey: cleanKey,
        algorithms: {
          kex: ['diffie-hellman-group14-sha256', 'diffie-hellman-group16-sha512'],
          cipher: ['aes128-ctr', 'aes192-ctr', 'aes256-ctr'],
          serverHostKey: ['ssh-rsa', 'ssh-ed25519'],
          hmac: ['hmac-sha2-256', 'hmac-sha2-512']
        }
      });
      
      // Search in multiple possible date-based directory structures
      const searchPaths = [
        `/${exportId}/`,                          // Main export directory
        `/${exportId}/2025/`,                     // Year folder
        `/${exportId}/2025/06/`,                  // Year/Month
        `/${exportId}/2025/06/23/`,               // Year/Month/Day
        `/${exportId}/2025/06/24/`,
        `/${exportId}/2025/06/25/`,
        `/${exportId}/2025/06/26/`,
        `/${exportId}/2025/06/27/`,
        `/${exportId}/2025/06/28/`,
        `/${exportId}/2025/06/29/`,
        `/${exportId}/2025/06/30/`,
        `/${exportId}/20250623/`,                 // YYYYMMDD format
        `/${exportId}/20250624/`,
        `/${exportId}/20250625/`,
        `/${exportId}/20250626/`,
        `/${exportId}/20250627/`,
        `/${exportId}/20250628/`,
        `/${exportId}/20250629/`,
        `/${exportId}/20250630/`,
        `/${exportId}/weekly/`,                   // Weekly exports
        `/${exportId}/daily/`,                    // Daily exports
        `/exports/${exportId}/`,                  // Alternative structure
        `/data/${exportId}/`
      ];

      let allFiles = [];
      let foundPaths = [];

      // Check each possible path
      for (const path of searchPaths) {
        try {
          const files = await sftp.list(path);
          if (files && files.length > 0) {
            foundPaths.push(path);
            
            // Add path info to each file
            const filesWithPath = files.map(file => ({
              ...file,
              fullPath: path + file.name,
              searchPath: path
            }));
            
            allFiles = allFiles.concat(filesWithPath);
          }
        } catch (e) {
          // Path doesn't exist, continue
          continue;
        }
      }

      // Filter files by date range
      const dateRangeFiles = allFiles.filter(file => {
        if (!file.modifyTime) return false;
        const fileDate = new Date(file.modifyTime);
        return fileDate >= start && fileDate <= end;
      });

      // Look for CSV files specifically
      const csvFiles = allFiles.filter(file => 
        file.name && file.name.toLowerCase().includes('.csv')
      );

      // Look for sales-related files
      const salesFiles = allFiles.filter(file => 
        file.name && (
          file.name.toLowerCase().includes('sales') ||
          file.name.toLowerCase().includes('transaction') ||
          file.name.toLowerCase().includes('revenue') ||
          file.name.toLowerCase().includes('order')
        )
      );

      // Get recent files (last 30 days)
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      
      const recentFiles = allFiles.filter(file => {
        if (!file.modifyTime) return false;
        const fileDate = new Date(file.modifyTime);
        return fileDate > thirtyDaysAgo;
      });

      await sftp.end();
      
      res.status(200).json({ 
        success: true, 
        message: 'File search completed',
        searchCriteria: {
          startDate: start.toISOString().split('T')[0],
          endDate: end.toISOString().split('T')[0],
          pathsSearched: searchPaths.length,
          pathsFound: foundPaths.length
        },
        results: {
          totalFilesFound: allFiles.length,
          filesInDateRange: dateRangeFiles.length,
          csvFiles: csvFiles.length,
          salesRelatedFiles: salesFiles.length,
          recentFiles: recentFiles.length,
          pathsWithFiles: foundPaths
        },
        files: {
          inDateRange: dateRangeFiles.slice(0, 10).map(f => ({
            name: f.name,
            path: f.searchPath,
            size: f.size,
            modified: new Date(f.modifyTime).toLocaleString(),
            type: f.type
          })),
          csvFiles: csvFiles.slice(0, 10).map(f => ({
            name: f.name,
            path: f.searchPath,
            size: f.size,
            modified: new Date(f.modifyTime).toLocaleString()
          })),
          salesFiles: salesFiles.slice(0, 10).map(f => ({
            name: f.name,
            path: f.searchPath,
            size: f.size,
            modified: new Date(f.modifyTime).toLocaleString()
          })),
          recentFiles: recentFiles.slice(0, 10).map(f => ({
            name: f.name,
            path: f.searchPath,
            size: f.size,
            modified: new Date(f.modifyTime).toLocaleString()
          }))
        }
      });
      
    } catch (connectionError) {
      await sftp.end();
      throw connectionError;
    }
    
  } catch (error) {
    console.error('File search error:', error);
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
