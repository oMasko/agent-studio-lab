import {
  InputGuardrailTripwireTriggered,
  OutputGuardrailTripwireTriggered,
  ToolInputGuardrailTripwireTriggered,
  ToolOutputGuardrailTripwireTriggered,
} from "@openai/agents";

export type GuardrailErrorInfo = {
  type: "input" | "output" | "tool_input" | "tool_output";
  name: string;
  message: string;
  outputInfo?: unknown;
};

export function guardrailErrorInfo(error: unknown): GuardrailErrorInfo | undefined {
  if (error instanceof InputGuardrailTripwireTriggered) {
    return {
      type: "input",
      name: error.result.guardrail.name,
      message: "输入被 Guardrail 拦截，模型未继续处理这条消息。",
      outputInfo: error.result.output.outputInfo,
    };
  }
  if (error instanceof OutputGuardrailTripwireTriggered) {
    return {
      type: "output",
      name: error.result.guardrail.name,
      message: "模型输出被 Guardrail 拦截，因此没有展示给用户。",
      outputInfo: error.result.output.outputInfo,
    };
  }
  if (error instanceof ToolInputGuardrailTripwireTriggered) {
    return {
      type: "tool_input",
      name: error.result.guardrail.name,
      message: "工具参数被 Guardrail 拦截，工具没有执行。",
      outputInfo: error.result.output.outputInfo,
    };
  }
  if (error instanceof ToolOutputGuardrailTripwireTriggered) {
    return {
      type: "tool_output",
      name: error.result.guardrail.name,
      message: "工具输出被 Guardrail 拦截。",
      outputInfo: error.result.output.outputInfo,
    };
  }
  return undefined;
}
