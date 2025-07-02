// api/consolidate-weekly-report.js
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

  const { sftpUsername, serverUrl, exportId, startDate, endDate, datarailsEmail, fileType } = req.body;
  
  try {
    if (!sftpUsername || !serverUrl || !exportId || !startDate || !endDate || !datarailsEmail) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required parameters: sftpUsername, serverUrl, exportId, startDate, endDate, datarailsEmail' 
      });
    }

    const privateKey = process.env.TOAST_SSH_PRIVATE_KEY;
    const resendApiKey = process.env.RESEND_API_KEY;
    
    if (!privateKey) {
      return res.status(400).json({ 
        success: false, 
        error: 'SSH key not found in environment variables' 
      });
    }

    if (!resendApiKey) {
      return res.status(400).json({ 
        success: false, 
        error: 'RESEND_API_KEY not found in environment variables' 
      });
    }

    const { default: SftpClient } = await import('ssh2-sftp-client');
    const sftp = new SftpClient();
    
    let downloadedFiles = [];
    let consolidatedData = [];
    let header = null;
    
    try {
      // Connect to SFTP
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

      let connected = false;
      let connectionError;

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
      
      // Generate date range
      const start = new Date(startDate);
      const end = new Date(endDate);
      const dates = [];
      
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const yyyymmdd = d.getFullYear() + 
                         String(d.getMonth() + 1).padStart(2, '0') + 
                         String(d.getDate()).padStart(2, '0');
        dates.push(yyyymmdd);
      }
      
      // Target file to download (default to OrderDetails.csv for sales data)
      const targetFile = fileType || 'OrderDetails.csv';
      
      // Download and consolidate files from each date
      for (const date of dates) {
        try {
          const remotePath = `/${exportId}/${date}/${targetFile}`;
          
          // Check if file exists
          const fileList = await sftp.list(`/${exportId}/${date}/`);
          const fileExists = fileList.find(f => f.name === targetFile);
          
          if (fileExists) {
            // Download the file
            const fileBuffer = await sftp.get(remotePath);
            const fileContent = fileBuffer.toString('utf8');
            
            // Parse CSV content
            const lines = fileContent.split('\n').filter(line => line.trim());
            
            if (lines.length > 0) {
              // Extract header from first file
              if (header === null) {
                header = lines[0];
              }
              
              // Add data rows (skip header for subsequent files)
              const dataRows = lines.slice(1);
              
              // Add date column to each row
              const dataWithDate = dataRows.map(row => {
                if (row.trim()) {
                  // Convert YYYYMMDD to readable date
                  const readableDate = `${date.slice(0,4)}-${date.slice(4,6)}-${date.slice(6,8)}`;
                  return `"${readableDate}",${row}`;
                }
                return '';
              }).filter(row => row);
              
              consolidatedData = consolidatedData.concat(dataWithDate);
              
              downloadedFiles.push({
                date: date,
                fileName: targetFile,
                size: fileExists.size,
                rowsAdded: dataWithDate.length,
                success: true
              });
            }
          } else {
            downloadedFiles.push({
              date: date,
              fileName: targetFile,
              size: 0,
              rowsAdded: 0,
              success: false,
              error: 'File not found'
            });
          }
          
        } catch (dateError) {
          downloadedFiles.push({
            date: date,
            fileName: targetFile,
            size: 0,
            rowsAdded: 0,
            success: false,
            error: dateError.message
          });
        }
      }

      await sftp.end();
      
      // Create consolidated CSV content
      let consolidatedCSV = '';
      if (header && consolidatedData.length > 0) {
        // Add Date column to header
        consolidatedCSV = `"Date",${header}\n`;
        consolidatedCSV += consolidatedData.join('\n');
      } else {
        consolidatedCSV = 'No data found for the specified date range';
      }
      
      // Create consolidated filename
      const consolidatedFileName = `Weekly_${targetFile.replace('.csv', '')}_${startDate}_to_${endDate}.csv`;
      
      const successfulDownloads = downloadedFiles.filter(f => f.success);
      const failedDownloads = downloadedFiles.filter(f => !f.success);
      const totalRows = consolidatedData.length;
      
      // Send email with consolidated file
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${resendApiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: 'Toast Automation <onboarding@resend.dev>',
          to: [datarailsEmail],
          subject: `Toast Consolidated Weekly Report - ${startDate} to ${endDate}`,
          html: `
            <p>Hello,</p>
            <p>Please find attached the consolidated Toast sales report for the period ${startDate} to ${endDate}.</p>
            
            <h3>Consolidation Summary:</h3>
            <ul>
              <li><strong>Report Type:</strong> ${targetFile}</li>
              <li><strong>Date Range:</strong> ${startDate} to ${endDate}</li>
              <li><strong>Days Processed:</strong> ${successfulDownloads.length} of ${dates.length}</li>
              <li><strong>Total Records:</strong> ${totalRows}</li>
              <li><strong>File Size:</strong> ${Math.round(consolidatedCSV.length / 1024)} KB</li>
            </ul>
            
            <h3>Successfully Processed Days (${successfulDownloads.length}):</h3>
            <ul>
              ${successfulDownloads.map(f => `
                <li>${f.date} - ${f.rowsAdded} records (${Math.round(f.size / 1024)} KB)</li>
              `).join('')}
            </ul>
            
            ${failedDownloads.length > 0 ? `
            <h3>Days Without Data (${failedDownloads.length}):</h3>
            <ul>
              ${failedDownloads.map(f => `
                <li>${f.date} - ${f.error || 'No data available'}</li>
              `).join('')}
            </ul>
            ` : ''}
            
            <p><strong>Note:</strong> Each record includes a "Date" column indicating the business day.</p>
            <p>This consolidated weekly report was automatically generated from Toast POS daily exports.</p>
            <p>Best regards,<br>Automated System</p>
          `,
          attachments: [
            {
              filename: consolidatedFileName,
              content: Buffer.from(consolidatedCSV, 'utf8').toString('base64')
            }
          ]
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Email sending failed: ${errorText}`);
      }

      const emailData = await response.json();
      
      res.status(200).json({ 
        success: true, 
        message: 'Consolidated weekly report created and sent successfully',
        summary: {
          dateRange: `${startDate} to ${endDate}`,
          fileType: targetFile,
          consolidatedFileName: consolidatedFileName,
          totalDays: dates.length,
          successfulDays: successfulDownloads.length,
          failedDays: failedDownloads.length,
          totalRecords: totalRows,
          fileSize: `${Math.round(consolidatedCSV.length / 1024)} KB`,
          emailMessageId: emailData.id
        },
        dailyFiles: downloadedFiles.map(f => ({
          date: f.date,
          success: f.success,
          rowsAdded: f.rowsAdded,
          size: f.size,
          error: f.error || null
        })),
        email: {
          success: true,
          messageId: emailData.id,
          to: datarailsEmail,
          fileName: consolidatedFileName
        }
      });
      
    } catch (operationError) {
      await sftp.end();
      throw operationError;
    }
    
  } catch (error) {
    console.error('Consolidation error:', error);
    res.status(500).json({ 
      success: false, 
      error: `Consolidation failed: ${error.message}`,
      details: {
        server: serverUrl,
        exportId: exportId,
        dateRange: `${startDate} to ${endDate}`
      }
    });
  }
}
