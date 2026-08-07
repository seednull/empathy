#include "common.h"

static void testExecutionEntryInOperand(Test_Context *context)
{
	const uint8_t payload[] =
	{
		EMPATHY_BYTECODE_OP_PUSH_U32, 0x00, 0x00, 0x00, 0x00,
		EMPATHY_BYTECODE_OP_END,
	};
	Empathy_EntryPointDesc entry = {1, EMPATHY_PROGRAM_OFFSET_NONE};
	Empathy_ProgramDesc desc =
	{
		context->layout,
		1, &entry,
		EMPATHY_BYTECODE_VERSION, sizeof(payload), payload,
	};
	Empathy_Program program = EMPATHY_NULL_HANDLE;
	Empathy_Result result = empathyCreateProgram(context->instance, &desc, &program);
	TEST_CHECK(result == EMPATHY_INVALID_INSTRUCTION_DATA);
}

static void testExecutionEntryMode(Test_Context *context)
{
	const uint8_t payload[] = {EMPATHY_BYTECODE_OP_REJECT};
	Empathy_EntryPointDesc entry = {0, EMPATHY_PROGRAM_OFFSET_NONE};
	Empathy_ProgramDesc desc =
	{
		context->layout,
		1, &entry,
		EMPATHY_BYTECODE_VERSION, sizeof(payload), payload,
	};
	Empathy_Program program = EMPATHY_NULL_HANDLE;
	Empathy_Result result = empathyCreateProgram(context->instance, &desc, &program);
	TEST_CHECK(result == EMPATHY_INVALID_INSTRUCTION_DATA);
}

static void testPredicateEntryMode(Test_Context *context)
{
	const uint8_t payload[] = {EMPATHY_BYTECODE_OP_END};
	Empathy_EntryPointDesc entry = {0, 0};
	Empathy_ProgramDesc desc =
	{
		context->layout,
		1, &entry,
		EMPATHY_BYTECODE_VERSION, sizeof(payload), payload,
	};
	Empathy_Program program = EMPATHY_NULL_HANDLE;
	Empathy_Result result = empathyCreateProgram(context->instance, &desc, &program);
	TEST_CHECK(result == EMPATHY_INVALID_INSTRUCTION_DATA);
}

int main(void)
{
	Test_Context context = {0};
	testCreateContext(&context);

	testExecutionEntryInOperand(&context);
	testExecutionEntryMode(&context);
	testPredicateEntryMode(&context);

	testDestroyContext(&context);
	return 0;
}
