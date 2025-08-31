/**
 * Fetch analysis data from database
 */
export async function fetchAnalysisData(
  supabase: any,
  analysisId: string
): Promise<{ analysis: any; fullAnalysis: any } | null> {
  
  // First check for duplicates
  const { data: allAnalyses, error: checkError } = await supabase
    .from('analysis_history')
    .select('id, full_analysis, created_at')
    .eq('id', analysisId)
    .order('created_at', { ascending: false });
  
  if (checkError) {
    console.error(`Error fetching analysis ${analysisId}:`, checkError);
    throw new Error(`Failed to fetch analysis: ${checkError.message}`);
  }
  
  if (!allAnalyses || allAnalyses.length === 0) {
    console.error(`Analysis ${analysisId} not found in database`);
    throw new Error('Analysis not found');
  }
  
  if (allAnalyses.length > 1) {
    console.warn(`⚠️ Found ${allAnalyses.length} duplicate analyses with ID ${analysisId}`);
    console.warn(`   Using most recent created at ${allAnalyses[0].created_at}`);
  }
  
  // Use the most recent analysis
  const analysis = allAnalyses[0];
  const fullAnalysis = analysis.full_analysis || {};
  
  return { analysis, fullAnalysis };
}