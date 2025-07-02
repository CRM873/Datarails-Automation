// api/run-labor-automation-resend.js
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

  const { manualDateRange } = req.body;
  
  try {
    // Restaurant configurations for labor reports
    const restaurants = [
      {
        name: "Tiki Turtle",
        exportId: "56571",
        datarailsEmail: "e2e4437e-b007-4e20-9db0-c75545aeda32@upload.datarails.com"
      },
      {
        name: "Pier 32", 
        exportId: "56585",
        datarailsEmail: "bc9389ba-56f0-4109-826a-306297cae8ae@upload.datarails.com"
      }
    ];
    
    // SFTP Configuration
    const sftpConfig = {
      username: 'GrovePointDataExportUser',
      serverUrl: 's-9b0f88558b264dfda.server.transfer.us-east-1.amazonaws.com'
    };

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
      startDate = new Date(manualDateRange.startDate);
      endDate = new Date(manualDateRange.endDate);
    } else {
      // Automatic calculation: previous Monday to Sunday
      const today = new Date();
      const dayOfWeek = today.getDay(); // 0 = Sunday, 1 = Monday, etc.
      
      // Calculate last Monday
      const daysToLastMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
      const lastMonday = new Date(today);
      lastMonday.setDate(today.getDate() - daysToLastMonday - 7); // Previous week's Monday
      
      // Calculate last Sunday (6 days after last Monday)
      const lastSunday = new Date(lastMonday);
      lastSunday.setDate(lastMonday.getDate() + 6);
      
      startDate = lastMonday;
      endDate = lastSunday;
    }

    const startDateStr = startDate.toISOString().split('T')[0];
    const endDateStr = endDate.toISOString().split('T')[0];

    const { default: SftpClient } = await import('ssh2-sftp-client');
    
    let automationResults = [];
    let overallLog = [];
    
    overallLog.push(`Starting labor reports automation for ${startDateStr} to ${endDateStr}`);
    overallLog.push(`Processing ${restaurants.length} restaurants: ${restaurants.map(r => r.name).join(', ')}`);

    // Process each restaurant separately
    for (const restaurant of restaurants) {
      const sftp = new SftpClient();
      let restaurantResult = {
        restaurant: restaurant,
        laborReport: null,
        success: false,
        error: null,
        log: []
      };

      try {
        restaurantResult.log.push(`Processing ${restaurant.name} labor data (Export ID: ${restaurant.exportId})`);
        
        // Connect to SFTP
        let cleanKey = privateKey.trim();
        if (!cleanKey.includes('-----BEGIN') && !cleanKey.includes('-----END')) {
          cleanKey = `-----BEGIN OPENSSH PRIVATE KEY-----\n${cleanKey}\n-----END OPENSSH PRIVATE KEY-----`;
        }
        cleanKey = cleanKey.replace(/\\n/g, '\n');
        
        const connectionConfig = {
          host: sftpConfig.serverUrl,
          username: sftpConfig.username,
          privateKey: Buffer.from(cleanKey),
          algorithms: {
            kex: ['diffie-hellman-group14-sha256', 'diffie-hellman-group16-sha512'],
            cipher: ['aes128-ctr', 'aes192-ctr', 'aes256-ctr'],
            serverHostKey: ['ssh-rsa', 'ssh-ed25519'],
            hmac: ['hmac-sha2-256', 'hmac-sha2-512']
          }
        };

        await sftp.connect(connectionConfig);
        restaurantResult.log.push('Successfully connected to Toast SFTP');
        
        // Generate date range
        const dates = [];
        for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
          const yyyymmdd = d.getFullYear() + 
                           String(d.getMonth() + 1).padStart(2, '0') + 
                           String(d.getDate()).padStart(2, '0');
          dates.push(yyyymmdd);
        }
        
        restaurantResult.log.push(`Processing ${dates.length} days: ${dates.join(', ')}`);
        
        // Process TimeEntries.csv (Labor Report)
        let consolidatedData = [];
        let header = null;
        let successfulDays = 0;
        let totalRecords = 0;
        
        restaurantResult.log.push(`Processing Labor Report (TimeEntries.csv)`);
        
        // Download and consolidate TimeEntries.csv from each date
        for (const date of dates) {
          try {
            const remotePath = `/${restaurant.exportId}/${date}/TimeEntries.csv`;
            
            // Check if file exists
            const fileList = await sftp.list(`/${restaurant.exportId}/${date}/`);
            const fileExists = fileList.find(f => f.name === 'TimeEntries.csv');
            
            if (fileExists && fileExists.size > 0) {
              // Download the file
              const fileBuffer = await sftp.get(remotePath);
              const fileContent = fileBuffer.toString('utf8');
              
              // Parse CSV content
              const lines = fileContent.split('\n').filter(line => line.trim());
              
              if (lines.length > 1) { // Must have header + at least one data row
                // Extract header from first file
                if (header === null) {
                  header = lines[0];
                }
                
                // Add data rows (skip header for subsequent files)
                const dataRows = lines.slice(1);
                
                // Add date and restaurant columns to each row
                const dataWithMetadata = dataRows.map(row => {
                  if (row.trim()) {
                    const readableDate = `${date.slice(0,4)}-${date.slice(4,6)}-${date.slice(6,8)}`;
                    return `"${readableDate}","${restaurant.name}",${row}`;
                  }
                  return '';
                }).filter(row => row);
                
                consolidatedData = consolidatedData.concat(dataWithMetadata);
                successfulDays++;
                totalRecords += dataWithMetadata.length;
                
                restaurantResult.log.push(`✓ Found ${dataWithMetadata.length} time entries for ${date}`);
              } else {
                restaurantResult.log.push(`⚠ TimeEntries.csv for ${date} exists but is empty`);
              }
            } else {
              restaurantResult.log.push(`⚠ No TimeEntries.csv found or file is empty for ${date}`);
            }
            
          } catch (dateError) {
            restaurantResult.log.push(`⚠ Warning: Error accessing ${date} - ${dateError.message}`);
            continue; // Skip missing files
          }
        }

        await sftp.end();
        restaurantResult.log.push('SFTP connection closed');
        
        // Create consolidated labor report
        if (header && consolidatedData.length > 0) {
          let consolidatedCSV = `"Date","Restaurant",${header}\n`;
          consolidatedCSV += consolidatedData.join('\n');
          
          const consolidatedFileName = `${restaurant.name.replace(/\s+/g, '_')}_Weekly_Labor_Report_${startDateStr}_to_${endDateStr}.csv`;
          
          const laborReport = {
            filename: consolidatedFileName,
            content: Buffer.from(consolidatedCSV, 'utf8').toString('base64'),
            records: totalRecords,
            days: successfulDays,
            size: consolidatedCSV.length
          };
          
          restaurantResult.log.push(`✓ Labor Report: ${totalRecords} time entries from ${successfulDays} days`);
          
          // Try multiple email approaches
          let emailSuccess = false;
          let emailMethod = '';
          let emailError = '';
          
          // Method 1: Try with your verified email as "from" but send to Datarails
          try {
            const emailResponse = await fetch('https://api.resend.com/emails', {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${resendApiKey}`,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                from: 'cromero@grove-pt.com <cromero@grove-pt.com>',
                to: [restaurant.datarailsEmail],
                subject: `${restaurant.name} - Weekly Labor Report - ${startDateStr} to ${endDateStr}`,
                html: `
                  <h2>${restaurant.name} - Weekly Labor Report</h2>
                  <p><strong>Report Period:</strong> ${startDateStr} to ${endDateStr} (Monday-Sunday)</p>
                  <p><strong>Restaurant:</strong> ${restaurant.name}</p>
                  <p><strong>Export ID:</strong> ${restaurant.exportId}</p>
                  <p><strong>Generated:</strong> ${new Date().toLocaleString()}</p>
                  
                  <h3>Labor Report Summary:</h3>
                  <ul>
                    <li><strong>File:</strong> ${consolidatedFileName}</li>
                    <li><strong>Time Entries:</strong> ${totalRecords.toLocaleString()}</li>
                    <li><strong>Days Processed:</strong> ${successfulDays} of ${dates.length}</li>
                    <li><strong>File Size:</strong> ${Math.round(laborReport.size / 1024)} KB</li>
                  </ul>
                  
                  <h3>Data Details:</h3>
                  <ul>
                    <li>Each record includes <strong>Date</strong> and <strong>Restaurant</strong> columns for easy identification</li>
                    <li>Data covers employee time entries, shifts, and labor hours</li>
                    <li>Perfect for payroll processing and labor cost analysis</li>
                  </ul>
                  
                  <p><em>This automated labor report was generated from Toast POS data for ${restaurant.name}.</em></p>
                  <p>Best regards,<br>Grove Point Automated Reporting System</p>
                `,
                attachments: [
                  {
                    filename: consolidatedFileName,
                    content: laborReport.content
                  }
                ]
              })
            });

            if (emailResponse.ok) {
              const emailResult = await emailResponse.json();
              emailSuccess = true;
              emailMethod = 'Direct Resend to Datarails';
              restaurantResult.log.push(`✓ Email sent directly to ${restaurant.datarailsEmail} (${emailResult.id})`);
            } else {
              const errorText = await emailResponse.text();
              emailError = errorText;
              throw new Error(`Method 1 failed: ${errorText}`);
            }
          } catch (method1Error) {
            restaurantResult.log.push(`⚠ Method 1 (Direct Resend) failed: ${method1Error.message}`);
            
            // Method 2: Send TWO separate emails - one to Datarails, one to you
            try {
              // First email to Datarails
              const datarailsResponse = await fetch('https://api.resend.com/emails', {
                method: 'POST',
                headers: {
                  'Authorization': `Bearer ${resendApiKey}`,
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                  from: 'Toast Labor Reports <onboarding@resend.dev>',
                  to: [restaurant.datarailsEmail],
                  subject: `${restaurant.name} - Weekly Labor Report - ${startDateStr} to ${endDateStr}`,
                  html: `
                    <h2>${restaurant.name} - Weekly Labor Report</h2>
                    <p><strong>Report Period:</strong> ${startDateStr} to ${endDateStr} (Monday-Sunday)</p>
                    <p><strong>Restaurant:</strong> ${restaurant.name}</p>
                    <p><strong>Export ID:</strong> ${restaurant.exportId}</p>
                    <p><strong>Generated:</strong> ${new Date().toLocaleString()}</p>
                    
                    <h3>Labor Report Summary:</h3>
                    <ul>
                      <li><strong>File:</strong> ${consolidatedFileName}</li>
                      <li><strong>Time Entries:</strong> ${totalRecords.toLocaleString()}</li>
                      <li><strong>Days Processed:</strong> ${successfulDays} of ${dates.length}</li>
                      <li><strong>File Size:</strong> ${Math.round(laborReport.size / 1024)} KB</li>
                    </ul>
                    
                    <p><em>This automated labor report was generated from Toast POS data for ${restaurant.name}.</em></p>
                    <p>Best regards,<br>Grove Point Automated Reporting System</p>
                  `,
                  attachments: [
                    {
                      filename: consolidatedFileName,
                      content: laborReport.content
                    }
                  ]
                })
              });

              let datarailsSuccess = false;
              let datarailsError = '';
              
              if (datarailsResponse.ok) {
                const datarailsResult = await datarailsResponse.json();
                datarailsSuccess = true;
                restaurantResult.log.push(`✓ Email sent directly to Datarails: ${restaurant.datarailsEmail} (${datarailsResult.id})`);
              } else {
                const errorText = await datarailsResponse.text();
                datarailsError = errorText;
                restaurantResult.log.push(`⚠ Direct Datarails email failed: ${errorText}`);
              }

              // Second email to you for confirmation
              const confirmationResponse = await fetch('https://api.resend.com/emails', {
                method: 'POST',
                headers: {
                  'Authorization': `Bearer ${resendApiKey}`,
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                  from: 'Toast Labor Reports <onboarding@resend.dev>',
                  to: ['cromero@grove-pt.com'],
                  subject: `${restaurant.name} - Labor Report Confirmation - ${datarailsSuccess ? 'SENT TO DATARAILS' : 'FAILED - MANUAL FORWARD NEEDED'}`,
                  html: `
                    <h2>${restaurant.name} - Labor Report Status</h2>
                    <div style="background-color: ${datarailsSuccess ? '#4CAF50' : '#ffeb3b'}; padding: 10px; border-radius: 5px; margin-bottom: 20px;">
                      <strong>${datarailsSuccess ? '✅ SUCCESS: Email sent directly to Datarails!' : '🚨 FAILED: Please forward manually'}</strong><br>
                      <strong>Datarails Email: ${restaurant.datarailsEmail}</strong>
                    </div>
                    <p><strong>Report Period:</strong> ${startDateStr} to ${endDateStr} (Monday-Sunday)</p>
                    <p><strong>Restaurant:</strong> ${restaurant.name}</p>
                    <p><strong>Records Processed:</strong> ${totalRecords.toLocaleString()} time entries</p>
                    <p><strong>File Size:</strong> ${Math.round(laborReport.size / 1024)} KB</p>
                    
                    ${datarailsSuccess ? 
                      '<p>✅ The labor report was successfully delivered to Datarails automatically.</p>' : 
                      '<p>❌ Direct delivery failed. Please forward the attached file manually.</p>'
                    }
                    
                    <p><em>Automation Status: ${datarailsSuccess ? 'Working perfectly!' : 'Needs manual intervention'}</em></p>
                  `,
                  attachments: datarailsSuccess ? [] : [
                    {
                      filename: consolidatedFileName,
                      content: laborReport.content
                    }
                  ]
                })
              });

              if (confirmationResponse.ok) {
                const confirmResult = await confirmationResponse.json();
                restaurantResult.log.push(`✓ Confirmation email sent to cromero@grove-pt.com (${confirmResult.id})`);
              }

              if (datarailsSuccess) {
                emailSuccess = true;
                emailMethod = 'Direct to Datarails + Confirmation';
              } else {
                throw new Error(`Direct Datarails delivery failed: ${datarailsError}`);
              }
              
            } catch (method2Error) {
              restaurantResult.log.push(`⚠ Method 2 (Dual emails) failed: ${method2Error.message}`);
              
              // Method 3: Fallback to your email only
              const emailResponse = await fetch('https://api.resend.com/emails', {
                method: 'POST',
                headers: {
                  'Authorization': `Bearer ${resendApiKey}`,
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                  from: 'Toast Labor Reports <onboarding@resend.dev>',
                  to: ['cromero@grove-pt.com'],
                  subject: `${restaurant.name} - Weekly Labor Report - ${startDateStr} to ${endDateStr} - FORWARD TO: ${restaurant.datarailsEmail}`,
                  html: `
                    <h2>${restaurant.name} - Weekly Labor Report</h2>
                    <div style="background-color: #ffeb3b; padding: 10px; border-radius: 5px; margin-bottom: 20px;">
                      <strong>🚨 MANUAL FORWARD REQUIRED TO:</strong><br>
                      <strong>${restaurant.datarailsEmail}</strong>
                    </div>
                    <p><strong>Report Period:</strong> ${startDateStr} to ${endDateStr} (Monday-Sunday)</p>
                    <p><strong>Restaurant:</strong> ${restaurant.name}</p>
                    <p><strong>Export ID:</strong> ${restaurant.exportId}</p>
                    <p><strong>Generated:</strong> ${new Date().toLocaleString()}</p>
                    
                    <h3>Labor Report Summary:</h3>
                    <ul>
                      <li><strong>File:</strong> ${consolidatedFileName}</li>
                      <li><strong>Time Entries:</strong> ${totalRecords.toLocaleString()}</li>
                      <li><strong>Days Processed:</strong> ${successfulDays} of ${dates.length}</li>
                      <li><strong>File Size:</strong> ${Math.round(laborReport.size / 1024)} KB</li>
                    </ul>
                    
                    <p><em>This automated labor report was generated from Toast POS data for ${restaurant.name}.</em></p>
                    <p>Best regards,<br>Grove Point Automated Reporting System</p>
                  `,
                  attachments: [
                    {
                      filename: consolidatedFileName,
                      content: laborReport.content
                    }
                  ]
                })
              });

              if (emailResponse.ok) {
                const emailResult = await emailResponse.json();
                emailSuccess = true;
                emailMethod = 'Fallback to manual forward';
                restaurantResult.log.push(`✓ Email sent to cromero@grove-pt.com for manual forward (${emailResult.id})`);
              } else {
                const errorText = await emailResponse.text();
                throw new Error(`All email methods failed. Last error: ${errorText}`);
              }
            }
          }

          if (emailSuccess) {
            restaurantResult.laborReport = {
              filename: laborReport.filename,
              records: laborReport.records,
              days: laborReport.days,
              size: `${Math.round(laborReport.size / 1024)} KB`,
              emailMethod: emailMethod
            };
            
            restaurantResult.success = true;
          } else {
            throw new Error(`Email delivery failed: ${emailError}`);
          }
          
        } else {
          throw new Error(`No labor data found for ${restaurant.name} in the specified date range. Found ${successfulDays} days with data out of ${dates.length} days searched.`);
        }
        
      } catch (restaurantError) {
        if (sftp) await sftp.end();
        restaurantResult.error = restaurantError.message;
        restaurantResult.log.push(`✗ Error: ${restaurantError.message}`);
      }
      
      automationResults.push(restaurantResult);
      overallLog = overallLog.concat(restaurantResult.log);
    }
    
    // Compile overall results
    const successfulRestaurants = automationResults.filter(r => r.success);
    const failedRestaurants = automationResults.filter(r => !r.success);
    const totalRecords = successfulRestaurants.reduce((sum, r) => sum + (r.laborReport?.records || 0), 0);
    
    res.status(200).json({ 
      success: successfulRestaurants.length > 0,
      message: `Labor automation completed: ${successfulRestaurants.length} successful, ${failedRestaurants.length} failed`,
      summary: {
        dateRange: `${startDateStr} to ${endDateStr}`,
        totalRestaurants: restaurants.length,
        successfulRestaurants: successfulRestaurants.length,
        failedRestaurants: failedRestaurants.length,
        totalLaborRecords: totalRecords,
        executionTime: new Date().toISOString()
      },
      restaurants: automationResults.map(r => ({
        name: r.restaurant.name,
        exportId: r.restaurant.exportId,
        datarailsEmail: r.restaurant.datarailsEmail,
        success: r.success,
        laborRecords: r.laborReport?.records || 0,
        daysProcessed: r.laborReport?.days || 0,
        fileSize: r.laborReport?.size || '0 KB',
        emailMethod: r.laborReport?.emailMethod || 'Failed',
        error: r.error,
        detailedLog: r.log
      })),
      log: overallLog
    });
    
  } catch (error) {
    console.error('Labor automation error:', error);
    res.status(500).json({ 
      success: false, 
      error: `Labor automation failed: ${error.message}`,
      log: overallLog || []
    });
  }
}
