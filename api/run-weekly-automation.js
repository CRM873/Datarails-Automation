// api/run-weekly-automation.js
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

  const { datarailsEmail, manualDateRange } = req.body;
  
  try {
    // Configuration - these could be moved to environment variables
    const sftpConfig = {
      username: 'GrovePointDataExportUser',
      serverUrl: 's-9b0f88558b264dfda.server.transfer.us-east-1.amazonaws.com',
      exportId: '56571'
    };

    if (!datarailsEmail) {
      return res.status(400).json({ 
        success: false, 
        error: 'datarailsEmail is required' 
      });
    }

    const privateKey = process.env.TOAST_SSH_PRIVATE_KEY;
    const resendApiKey = process.env.RESEND_API_KEY;
    
    if (!privateKey || !resendApiKey) {
      return res.status(400).json({ 
        success: false, 
        error: 'Required environment variables not found (SSH key or Resend API key)' 
      });
    }

    // Calculate previous week's date range (Monday to Sunday)
    let startDate, endDate;
    
    if (manualDateRange) {
      // Manual override for testing
      startDate = new Date(manualDateRange.startDate);
      endDate = new Date(manualDateRange.endDate);
    } else {
      // Automatic calculation: previous Monday to Sunday
      const today = new Date();
      const dayOfWeek = today.getDay(); // 0 = Sunday, 1 = Monday, etc.
      
      // Calculate last Monday
      const daysToLastMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1; // If Sunday, go back 6 days
      const lastMonday = new Date(today);
      lastMonday.setDate(today.getDate() - daysToLastMonday - 7); // Go back to previous week's Monday
      
      // Calculate last Sunday (6 days after last Monday)
      const lastSunday = new Date(lastMonday);
      lastSunday.setDate(lastMonday.getDate() + 6);
      
      startDate = lastMonday;
      endDate = lastSunday;
    }

    const startDateStr = startDate.toISOString().split('T')[0];
    const endDateStr = endDate.toISOString().split('T')[0];

    // Files to download and consolidate
    const reportTypes = [
      { file: 'OrderDetails.csv', description: 'Order Summary' },
      { file: 'CheckDetails.csv', description: 'Transaction Details' },
      { file: 'PaymentDetails.csv', description: 'Payment Information' },
      { file: 'ItemSelectionDetails.csv', description: 'Detailed Item Sales' },
      { file: 'TimeEntries.csv', description: 'Labor/Time Entries' }
    ];

    const { default: SftpClient } = await import('ssh2-sftp-client');
    const sftp = new SftpClient();
    
    let consolidatedReports = [];
    let automationLog = [];
    let totalRecords = 0;
    
    try {
      automationLog.push(`Starting weekly automation for ${startDateStr} to ${endDateStr}`);
      
      // Connect to SFTP
      let cleanKey = privateKey.trim();
      if (!cleanKey.includes('-----BEGIN') && !cleanKey.includes('-----END')) {
        cleanKey = `-----BEGIN OPENSSH PRIVATE KEY-----\n${cleanKey}\n-----END OPENSSH PRIVATE KEY-----`;
      }
      cleanKey = cleanKey.replace(/\\n/g, '\n');
      
      const connectionConfigs = [
        {
          host: sftpConfig.serverUrl,
          username: sftpConfig.username,
          privateKey: Buffer.from(cleanKey),
          algorithms: {
            kex: ['diffie-hellman-group14-sha256', 'diffie-hellman-group16-sha512'],
            cipher: ['aes128-ctr', 'aes192-ctr', 'aes256-ctr'],
            serverHostKey: ['ssh-rsa', 'ssh-ed25519'],
            hmac: ['hmac-sha2-256', 'hmac-sha2-512']
          }
        }
      ];

      await sftp.connect(connectionConfigs[0]);
      automationLog.push('Successfully connected to Toast SFTP');
      
      // Generate date range
      const dates = [];
      for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
        const yyyymmdd = d.getFullYear() + 
                         String(d.getMonth() + 1).padStart(2, '0') + 
                         String(d.getDate()).padStart(2, '0');
        dates.push(yyyymmdd);
      }
      
      automationLog.push(`Processing ${dates.length} days: ${dates.join(', ')}`);
      
      // Process each report type
      for (const reportType of reportTypes) {
        try {
          automationLog.push(`Processing ${reportType.description} (${reportType.file})`);
          
          let consolidatedData = [];
          let header = null;
          let successfulDays = 0;
          let reportSize = 0;
          
          // Download and consolidate files from each date
          for (const date of dates) {
            try {
              const remotePath = `/${sftpConfig.exportId}/${date}/${reportType.file}`;
              
              // Check if file exists
              const fileList = await sftp.list(`/${sftpConfig.exportId}/${date}/`);
              const fileExists = fileList.find(f => f.name === reportType.file);
              
              if (fileExists) {
                // Download the file
                const fileBuffer = await sftp.get(remotePath);
                const fileContent = fileBuffer.toString('utf8');
                reportSize += fileBuffer.length;
                
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
                      const readableDate = `${date.slice(0,4)}-${date.slice(4,6)}-${date.slice(6,8)}`;
                      return `"${readableDate}",${row}`;
                    }
                    return '';
                  }).filter(row => row);
                  
                  consolidatedData = consolidatedData.concat(dataWithDate);
                  successfulDays++;
                }
              }
              
            } catch (dateError) {
              // Continue processing other dates if one fails
              continue;
            }
          }
          
          // Create consolidated CSV content for this report type
          if (header && consolidatedData.length > 0) {
            let consolidatedCSV = `"Date",${header}\n`;
            consolidatedCSV += consolidatedData.join('\n');
            
            const consolidatedFileName = `Weekly_${reportType.file.replace('.csv', '')}_${startDateStr}_to_${endDateStr}.csv`;
            
            consolidatedReports.push({
              filename: consolidatedFileName,
              content: Buffer.from(consolidatedCSV, 'utf8').toString('base64'),
              description: reportType.description,
              records: consolidatedData.length,
              days: successfulDays,
              size: consolidatedCSV.length
            });
            
            totalRecords += consolidatedData.length;
            automationLog.push(`✓ ${reportType.description}: ${consolidatedData.length} records from ${successfulDays} days`);
          } else {
            automationLog.push(`✗ ${reportType.description}: No data found for date range`);
          }
          
        } catch (reportError) {
          automationLog.push(`✗ ${reportType.description}: Failed - ${reportError.message}`);
        }
      }

      await sftp.end();
      automationLog.push('SFTP connection closed');
      
      // Send email with all consolidated reports
      if (consolidatedReports.length > 0) {
        const response = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${resendApiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            from: 'Toast Automation <onboarding@resend.dev>',
            to: [datarailsEmail],
            subject: `Toast Weekly Reports - ${startDateStr} to ${endDateStr}`,
            html: `
              <h2>Toast Weekly Reports</h2>
              <p><strong>Report Period:</strong> ${startDateStr} to ${endDateStr}</p>
              <p><strong>Generated:</strong> ${new Date().toLocaleString()}</p>
              
              <h3>Reports Included:</h3>
              <ul>
                ${consolidatedReports.map(report => `
                  <li><strong>${report.description}</strong> (${report.filename})
                    <ul>
                      <li>Records: ${report.records.toLocaleString()}</li>
                      <li>Days: ${report.days} of ${dates.length}</li>
                      <li>Size: ${Math.round(report.size / 1024)} KB</li>
                    </ul>
                  </li>
                `).join('')}
              </ul>
              
              <h3>Summary:</h3>
              <ul>
                <li><strong>Total Reports:</strong> ${consolidatedReports.length}</li>
                <li><strong>Total Records:</strong> ${totalRecords.toLocaleString()}</li>
                <li><strong>Date Range:</strong> ${dates.length} days (${startDateStr} to ${endDateStr})</li>
                <li><strong>Total Size:</strong> ${Math.round(consolidatedReports.reduce((sum, r) => sum + r.size, 0) / 1024)} KB</li>
              </ul>
              
              <h3>Processing Log:</h3>
              <ul>
                ${automationLog.map(log => `<li>${log}</li>`).join('')}
              </ul>
              
              <p><em>This automated report was generated from Toast POS data and delivered via the Toast-Datarails integration.</em></p>
              <p>Best regards,<br>Automated Reporting System</p>
            `,
            attachments: consolidatedReports.map(report => ({
              filename: report.filename,
              content: report.content
            }))
          })
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Email sending failed: ${errorText}`);
        }

        const emailData = await response.json();
        automationLog.push(`✓ Email sent successfully (${emailData.id})`);
        
        res.status(200).json({ 
          success: true, 
          message: 'Weekly automation completed successfully',
          summary: {
            dateRange: `${startDateStr} to ${endDateStr}`,
            reportsGenerated: consolidatedReports.length,
            totalRecords: totalRecords,
            totalDays: dates.length,
            emailSent: true,
            emailMessageId: emailData.id,
            recipientEmail: datarailsEmail,
            executionTime: new Date().toISOString()
          },
          reports: consolidatedReports.map(r => ({
            description: r.description,
            filename: r.filename,
            records: r.records,
            days: r.days,
            size: `${Math.round(r.size / 1024)} KB`
          })),
          log: automationLog
        });
        
      } else {
        throw new Error('No reports could be generated - no data found for the specified date range');
      }
      
    } catch (operationError) {
      await sftp.end();
      automationLog.push(`✗ Error: ${operationError.message}`);
      throw operationError;
    }
    
  } catch (error) {
    console.error('Weekly automation error:', error);
    res.status(500).json({ 
      success: false, 
      error: `Weekly automation failed: ${error.message}`,
      log: automationLog || [],
      summary: {
        dateRange: startDate && endDate ? `${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]}` : 'Unknown',
        reportsGenerated: 0,
        totalRecords: 0,
        emailSent: false
      }
    });
  }
}
