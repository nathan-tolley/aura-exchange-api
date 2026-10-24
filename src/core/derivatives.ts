import {Decimal} from "decimal.js";

export type PredictionSide="YES"|"NO";
export type OptionType="CALL"|"PUT";

export function impliedProbability(yes:Decimal.Value,no:Decimal.Value):number{
  const y=new Decimal(yes).plus(100),n=new Decimal(no).plus(100);
  return y.div(y.plus(n)).mul(100).toDecimalPlaces(1).toNumber();
}

export function optionPremium(spot:Decimal.Value,strike:Decimal.Value,type:OptionType,durationMs:number):Decimal{
  const s=new Decimal(spot),k=new Decimal(strike);
  const intrinsic=type==="CALL"?Decimal.max(0,s.minus(k)):Decimal.max(0,k.minus(s));
  const days=new Decimal(Math.max(durationMs,60_000)).div(86_400_000);
  const timeValue=s.mul("0.04").mul(days.div(7).sqrt());
  return Decimal.max("0.50",Decimal.min(s.mul("0.30"),intrinsic.plus(timeValue))).toDecimalPlaces(8);
}

export function optionPayout(spot:Decimal.Value,strike:Decimal.Value,type:OptionType,quantity:Decimal.Value):Decimal{
  const intrinsic=type==="CALL"?Decimal.max(0,new Decimal(spot).minus(strike)):Decimal.max(0,new Decimal(strike).minus(spot));
  return intrinsic.mul(quantity).toDecimalPlaces(8);
}

export function strikeSet(spot:Decimal.Value):number[]{
  const s=new Decimal(spot);
  return [s.mul("0.90"),s,s.mul("1.10")].map(value=>value.toDecimalPlaces(0,Decimal.ROUND_HALF_UP).toNumber());
}
