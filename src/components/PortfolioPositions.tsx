import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TrendingUp, TrendingDown, Loader2, Activity, AlertCircle, AlertTriangle } from "lucide-react";
import { alpacaAPI } from "@/lib/alpaca";
import { useAuth } from "@/lib/auth";
import { supabase } from "@/lib/supabase";
import { useToast } from "@/hooks/use-toast";
import { useAlpacaConnectionStore } from "@/hooks/useAlpacaConnection";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogFooter,
  AlertDialogAction,
} from "@/components/ui/alert-dialog";
import {
  ANALYSIS_STATUS,
  convertLegacyAnalysisStatus,
  isAnalysisActive
} from "@/lib/statusTypes";

interface Position {
  symbol: string;
  shares: number;
  avgCost: number;
  currentPrice: number;
  marketValue: number;
  unrealizedPL: number;
  unrealizedPLPct: number;
  dayChange: number;
}

interface PortfolioPositionsProps {
  onSelectStock?: (symbol: string) => void;
  selectedStock?: string;
}

export default function PortfolioPositions({ onSelectStock, selectedStock }: PortfolioPositionsProps) {
  const navigate = useNavigate();
  const { apiSettings, isAuthenticated, user } = useAuth();
  const { toast } = useToast();
  const { isConnected: isAlpacaConnected } = useAlpacaConnectionStore();
  const [positions, setPositions] = useState<Position[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [runningAnalysesCount, setRunningAnalysesCount] = useState(0);



  const fetchPositions = async () => {
    setLoading(true);
    setError(null);

    try {
      // Use batch endpoint to get account and positions together
      const accountBatchData = await alpacaAPI.getBatchAccountData().catch(err => {
        console.warn("Failed to get account/positions:", err);
        // Check if it's a configuration error
        if (err.message?.includes('API settings not found') || 
            err.message?.includes('not configured')) {
          console.log("Alpaca API not configured, showing empty positions");
          setError(null);
          return { positions: [] };
        }
        // Check for timeout or connection issues - likely Alpaca is down
        if (err.message?.includes('timeout') ||
            err.message?.includes('504') ||
            err.message?.includes('503') ||
            err.message?.includes('Unable to connect to Alpaca') ||
            err.message?.includes('Alpaca services appear to be down') ||
            err.message?.includes('Alpaca rate limit') ||
            err.message?.includes('https://app.alpaca.markets/dashboard/overview')) {
          console.log("Alpaca API appears to be down or rate limited:", err.message);
          
          // Extract the meaningful error message
          let errorMessage = err.message;
          if (err.message?.includes('https://app.alpaca.markets/dashboard/overview')) {
            // Already has the full message with link
            errorMessage = err.message;
          } else if (err.message?.includes('503') || err.message?.includes('504')) {
            errorMessage = "Unable to connect to Alpaca. Please check if Alpaca services are operational at https://app.alpaca.markets/dashboard/overview";
          }
          
          toast({
            title: "Alpaca Connection Error",
            description: errorMessage,
            variant: "destructive",
            duration: 10000, // Show for 10 seconds
          });
          setError(null);
          return { positions: [] };
        }
        // For other errors, still return empty data instead of throwing
        console.error("Error fetching account data, continuing with empty positions:", err);
        return { positions: [] };
      });

      const alpacaPositions = accountBatchData.positions || [];

      // If we got an empty array due to configuration, just return
      if (!alpacaPositions || alpacaPositions.length === 0) {
        setPositions([]);
        setError(null);
        return;
      }

      // Get batch data for all positions to get today's open prices
      const symbols = alpacaPositions.map((pos: any) => pos.symbol);
      let batchData: any = {};

      if (symbols.length > 0) {
        try {
          batchData = await alpacaAPI.getBatchData(symbols, {
            includeQuotes: true,
            includeBars: true
          });
        } catch (err) {
          console.warn('Could not fetch batch data for daily changes:', err);
        }
      }

      const formattedPositions: Position[] = alpacaPositions.map((pos: any) => {
        const currentPrice = parseFloat(pos.current_price);
        let dayChangePercent = parseFloat(pos.change_today); // Default to API value

        // Calculate today's change from open if we have the data
        const stockData = batchData[pos.symbol];
        if (stockData?.currentBar) {
          const todayOpen = stockData.currentBar.o;
          const priceChange = currentPrice - todayOpen;
          dayChangePercent = todayOpen > 0 ? (priceChange / todayOpen) * 100 : 0;
          console.log(`${pos.symbol}: Open: ${todayOpen}, Current: ${currentPrice}, Change: ${dayChangePercent.toFixed(2)}%`);
        } else if (stockData?.previousBar) {
          // Fallback to previous close if no current bar (market closed)
          const previousClose = stockData.previousBar.c;
          const priceChange = currentPrice - previousClose;
          dayChangePercent = previousClose > 0 ? (priceChange / previousClose) * 100 : 0;
        }

        return {
          symbol: pos.symbol,
          shares: parseFloat(pos.qty),
          avgCost: parseFloat(pos.avg_entry_price),
          currentPrice: currentPrice,
          marketValue: parseFloat(pos.market_value),
          unrealizedPL: parseFloat(pos.unrealized_pl),
          unrealizedPLPct: parseFloat(pos.unrealized_plpc) * 100,
          dayChange: dayChangePercent
        };
      });

      setPositions(formattedPositions);
      setLastRefresh(new Date());
    } catch (err) {
      console.error('Error fetching positions:', err);
      const errorMessage = err instanceof Error ? err.message : 'Failed to fetch positions';

      if (errorMessage.includes('Internal Server Error') || errorMessage.includes('500')) {
        setError('Database access error. Please check your configuration and try refreshing the page.');
      } else if (errorMessage.includes('Edge Function returned') || errorMessage.includes('API settings not found')) {
        //setError('API configuration not found. Please configure your Alpaca API in Settings.');
      } else {
        setError(errorMessage);
      }

      setPositions([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchPositions();

    // Refresh positions every 30 seconds
    const interval = setInterval(fetchPositions, 30000);
    return () => clearInterval(interval);
  }, [apiSettings]);

  // Check for running analyses
  useEffect(() => {
    const checkRunningAnalyses = async () => {
      if (!user) return;

      try {
        const { data, error } = await supabase
          .from('analysis_history')
          .select('id, analysis_status, is_canceled')
          .eq('user_id', user.id);

        if (!error && data) {
          const runningCount = data.filter(item => {
            // Convert legacy numeric status if needed
            const currentStatus = typeof item.analysis_status === 'number' 
              ? convertLegacyAnalysisStatus(item.analysis_status)
              : item.analysis_status;
            
            // Skip cancelled analyses
            if (item.is_canceled || currentStatus === ANALYSIS_STATUS.CANCELLED) {
              return false;
            }
            
            // Use centralized logic to check if analysis is active
            return isAnalysisActive(currentStatus);
          }).length;
          
          setRunningAnalysesCount(runningCount);
        }
      } catch (error) {
        console.error('Error checking running analyses:', error);
      }
    };

    checkRunningAnalyses();
    const interval = setInterval(checkRunningAnalyses, 10000);
    return () => clearInterval(interval);
  }, [user]);


  return (
    <>
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <CardTitle className="text-base font-semibold">Holdings</CardTitle>
              {apiSettings && (
                <Badge variant={apiSettings.alpaca_paper_trading ? "secondary" : "destructive"} className="text-xs">
                  {apiSettings.alpaca_paper_trading ? "Paper" : "Live"}
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-2">
              {/* Holdings controls can be added here if needed */}
            </div>
          </div>
          {lastRefresh && (
            <p className="text-xs text-muted-foreground">
              Last updated: {lastRefresh.toLocaleTimeString()}
            </p>
          )}
          {error && (
            <p className="text-xs text-red-500 mt-1">{error}</p>
          )}
        </CardHeader>
        <CardContent className="p-0">
          <div className="relative">
            <Table>
              <TableHeader className="sticky top-0 bg-background z-10 shadow-sm">
                <TableRow>
                  <TableHead className="w-[60px] text-xs">Symbol</TableHead>
                  <TableHead className="text-right text-xs px-2">Shares</TableHead>
                  <TableHead className="text-right text-xs px-2">Value</TableHead>
                  <TableHead className="text-right text-xs px-2">Daily</TableHead>
                  <TableHead className="text-right text-xs px-2">Total</TableHead>
                </TableRow>
              </TableHeader>
            </Table>
            <div className="max-h-[210px] overflow-y-auto">
              <Table>
                <TableBody>
                  {positions.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={5} className="text-center text-sm text-muted-foreground py-4">
                        {loading ? "Loading positions..." :
                          error ? error :
                            "No positions found"}
                      </TableCell>
                    </TableRow>
                  ) : (
                    positions.map((position) => (
                      <TableRow
                        key={position.symbol}
                        className={`cursor-pointer hover:bg-muted/50 transition-colors ${selectedStock === position.symbol ? 'bg-muted' : ''
                          }`}
                        onClick={() => onSelectStock?.(position.symbol)}
                      >
                        <TableCell className="font-medium w-[60px]">
                          <Badge variant={selectedStock === position.symbol ? 'default' : 'outline'}>
                            {position.symbol}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right text-sm px-2">{position.shares.toFixed(2)}</TableCell>
                        <TableCell className="text-right font-medium text-sm px-2">
                          ${(position.marketValue / 1000).toFixed(1)}k
                        </TableCell>
                        <TableCell className="text-right px-2">
                          <div className={`flex items-center justify-end gap-1 ${position.dayChange >= 0 ? 'text-success' : 'text-danger'
                            }`}>
                            {position.dayChange >= 0 ? (
                              <TrendingUp className="w-3 h-3" />
                            ) : (
                              <TrendingDown className="w-3 h-3" />
                            )}
                            <span className="text-xs font-medium">
                              {position.dayChange >= 0 ? '+' : ''}{position.dayChange.toFixed(1)}%
                            </span>
                          </div>
                        </TableCell>
                        <TableCell className="text-right px-2">
                          <div className={`flex items-center justify-end gap-1 ${position.unrealizedPL >= 0 ? 'text-success' : 'text-danger'
                            }`}>
                            {position.unrealizedPL >= 0 ? (
                              <TrendingUp className="w-3 h-3" />
                            ) : (
                              <TrendingDown className="w-3 h-3" />
                            )}
                            <span className="text-xs font-medium">
                              {position.unrealizedPLPct >= 0 ? '+' : ''}{position.unrealizedPLPct.toFixed(1)}%
                            </span>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </div>
        </CardContent>
      </Card>

      
    </>
  );
}